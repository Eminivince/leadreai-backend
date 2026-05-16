import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { processEmailEvent, processInboundEmail } from '../services/emailEvent.service.js';
import { verifyUnsubscribeToken } from '../services/unsubscribe.js';
import { SuppressionEntry } from '../models/SuppressionList.js';
import Lead from '../models/Lead.js';
import SequenceEnrollment from '../models/SequenceEnrollment.js';
import Sequence from '../models/Sequence.js';
import { logger } from '../utils/logger.js';

export async function handleResendWebhook(req: Request, res: Response): Promise<void> {
  // Respond 200 immediately — processing is async but we do it synchronously here for simplicity
  try {
    const payload = req.body as Record<string, unknown>;
    await processEmailEvent('resend', payload);
  } catch (err) {
    logger.error('[webhooks] Resend processing error', { err });
  }
  res.status(200).json({ received: true });
}

export async function handleSendGridWebhook(req: Request, res: Response): Promise<void> {
  // SendGrid sends an array of events
  const events = Array.isArray(req.body) ? req.body as Record<string, unknown>[] : [req.body as Record<string, unknown>];
  for (const event of events) {
    try {
      await processEmailEvent('sendgrid', event);
    } catch (err) {
      logger.error('[webhooks] SendGrid processing error', { err });
    }
  }
  res.status(200).json({ received: true });
}

export async function handleResendInbound(req: Request, res: Response): Promise<void> {
  try {
    const payload = req.body as Record<string, unknown>;
    if (payload['type'] === 'email.received') {
      await processInboundEmail('resend', payload);
    }
  } catch (err) {
    logger.error('[webhooks] Resend inbound processing error', { err });
  }
  res.status(200).json({ received: true });
}

export async function handleSendGridInbound(req: Request, res: Response): Promise<void> {
  // SendGrid Inbound Parse sends multipart/form-data. Express must be configured
  // with a multipart body parser (multer or express-formidable) for this route to
  // receive a populated req.body. Without it, req.body.headers will be undefined
  // and the call is a no-op.
  try {
    const payload = req.body as Record<string, unknown>;
    if (!payload['headers']) {
      logger.warn('[webhooks] SendGrid inbound: missing headers field — ensure multipart body parser is configured');
    } else {
      await processInboundEmail('sendgrid', payload);
    }
  } catch (err) {
    logger.error('[webhooks] SendGrid inbound processing error', { err });
  }
  res.status(200).json({ received: true });
}

export async function handleUnsubscribe(req: Request, res: Response): Promise<void> {
  const { t } = req.query as { t?: string };

  if (!t) {
    res.status(400).send('<h1>Invalid unsubscribe link</h1><p>No token provided.</p>');
    return;
  }

  try {
    const { wid, email } = verifyUnsubscribeToken(t);

    if (!mongoose.Types.ObjectId.isValid(wid)) {
      res.status(400).send('<h1>Invalid unsubscribe link</h1>');
      return;
    }

    // Add to suppression list
    await SuppressionEntry.updateOne(
      { workspaceId: wid, email: email.toLowerCase() },
      { $setOnInsert: { workspaceId: wid, email: email.toLowerCase(), reason: 'unsubscribe', addedAt: new Date() } },
      { upsert: true },
    );

    // Update lead outreachStatus
    await Lead.updateMany(
      { workspaceId: wid, 'emails.address': email.toLowerCase() },
      { $set: { outreachStatus: 'unsubscribed', suppressedAt: new Date(), suppressReason: 'unsubscribed' } },
    );

    // Stop all active enrollments for this email/workspace
    const leadsToStop = await Lead.find({ workspaceId: wid, 'emails.address': email.toLowerCase() }).select('_id');
    const leadIds = leadsToStop.map(l => l._id);
    if (leadIds.length > 0) {
      const enrollments = await SequenceEnrollment.find({
        workspaceId: wid,
        leadId: { $in: leadIds },
        status: 'active',
      }).select('_id sequenceId');

      for (const enrollment of enrollments) {
        await SequenceEnrollment.updateOne(
          { _id: enrollment._id },
          { $set: { status: 'unsubscribed', stopReason: 'unsubscribe', completedAt: new Date() } },
        );
        await Sequence.updateOne(
          { _id: enrollment.sequenceId, 'stats.active': { $gt: 0 } },
          { $inc: { 'stats.unsubscribed': 1, 'stats.active': -1 } },
        );
      }
    }

    res.status(200).send(`<!DOCTYPE html><html><head><title>Unsubscribed</title></head><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center"><h1>You've been unsubscribed</h1><p>You will no longer receive emails from this sender.</p></body></html>`);
  } catch (err) {
    logger.error('[webhooks] Unsubscribe error', { err });
    res.status(400).send('<h1>Invalid or expired unsubscribe link.</h1>');
  }
}
