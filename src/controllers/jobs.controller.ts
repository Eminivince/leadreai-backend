import { type Request, type Response } from 'express';
import ProspectingJob from '../models/ProspectingJob.js';
import { parseQuery } from '../services/ai/queryParser.js';
import { generateClarifications } from '../services/ai/queryClarifier.js';
import { checkQueryPolicy } from '../services/ai/queryGuardrail.js';
import { dispatchProspectingJob } from '../services/queue/jobDispatcher.js';
import { getProspectingQueue } from '../services/queue/queues.js';
import { chargeCredits, grantCredits } from '../services/credits.js';
import { ApiError } from '../utils/ApiError.js';
import { JOB_STATUSES, type ClarificationAnswer } from '../../shared/index.js';
import { env } from '../config/env.js';

export async function createJob(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const { rawQuery, clarifications, verifiedEmailsOnly } = req.body as {
    rawQuery: string;
    clarifications?: ClarificationAnswer[];
    verifiedEmailsOnly?: boolean;
  };

  if (!rawQuery || typeof rawQuery !== 'string' || !rawQuery.trim()) {
    throw ApiError.badRequest('rawQuery is required');
  }

  // Defense-in-depth — re-run the policy guardrail. Clients that skipped
  // /clarify shouldn't be able to bypass policy by going straight to /jobs.
  // The cost is ~$0.001 per submission; the safety story is worth it.
  const policy = await checkQueryPolicy(rawQuery);
  if (policy.decision === 'refuse') {
    throw new ApiError(
      400,
      'POLICY_REFUSED',
      policy.reason ?? 'This query falls outside what the platform will search for. Try reframing around companies, organizations, or named decision-makers in professional capacity.',
    );
  }

  // Atomic deduct via credits service (skips if CREDITS_PER_JOB = 0).
  if (env.CREDITS_PER_JOB > 0) {
    await chargeCredits({
      userId: req.user!._id,
      workspaceId: workspaceId!,
      amount: env.CREDITS_PER_JOB,
      reason: 'dispatch',
      description: `Dispatch: "${rawQuery.slice(0, 80)}${rawQuery.length > 80 ? '…' : ''}"`,
    });
  }

  const parsedIntent = await parseQuery(rawQuery, clarifications);

  const job = await ProspectingJob.create({
    workspaceId,
    createdBy: req.user!._id,
    rawQuery,
    clarifications,
    parsedIntent,
    status: 'queued',
    creditsCharged: env.CREDITS_PER_JOB,
    verifiedEmailsOnly: !!verifiedEmailsOnly,
  });

  let bullmqJob;
  try {
    bullmqJob = await dispatchProspectingJob(job._id.toString(), workspaceId!);
  } catch (err) {
    // Refund credit on dispatch failure. Always refunds to the top-up
    // bucket, which keeps the credit persistent (monthly refunds would
    // expire at next renewal). Small over-generosity is the right tradeoff
    // for a failure the user didn't cause.
    if (env.CREDITS_PER_JOB > 0) {
      await grantCredits({
        userId: req.user!._id,
        workspaceId: workspaceId!,
        amount: env.CREDITS_PER_JOB,
        bucket: 'topup',
        reason: 'dispatch.refund',
        description: 'Refund — dispatch failed to queue',
        metadata: { jobId: String(job._id) },
      }).catch(() => {});
    }
    await ProspectingJob.deleteOne({ _id: job._id });
    throw err;
  }
  job.bullmqJobId = bullmqJob.id ?? undefined;
  await job.save();

  res.status(201).json({ success: true, data: job });
}

/**
 * Pre-flight: runs the policy guardrail, then (if allowed) generates the
 * clarification checklist. Stateless — no job persisted, no credits charged.
 *
 * If the guardrail refuses, we skip the clarifier call entirely (save a
 * token) and return only the policy payload. The UI renders a refusal
 * panel with reframe suggestions.
 */
export async function clarifyQuery(req: Request, res: Response): Promise<void> {
  const { rawQuery } = req.body as { rawQuery: string };

  if (!rawQuery || typeof rawQuery !== 'string' || rawQuery.trim().length < 10) {
    throw ApiError.badRequest('rawQuery must be at least 10 characters');
  }

  // Run in parallel — they're independent reads of the same query.
  const [policy, questions] = await Promise.all([
    checkQueryPolicy(rawQuery),
    generateClarifications(rawQuery),
  ]);

  if (policy.decision === 'refuse') {
    res.json({ success: true, data: { policy, questions: [] } });
    return;
  }

  res.json({ success: true, data: { policy, questions } });
}

export async function listJobs(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
  const status = req.query.status as string | undefined;

  if (status && !(JOB_STATUSES as readonly string[]).includes(status)) {
    throw ApiError.badRequest('Invalid status value');
  }

  const filter: Record<string, unknown> = { workspaceId, ...(status ? { status } : {}) };
  const skip = (page - 1) * limit;

  const [jobs, total] = await Promise.all([
    ProspectingJob.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      // Keep last N log lines per job so the dashboard can show “what happened” without refetching each job.
      .slice('activityLog', -100),
    ProspectingJob.countDocuments(filter),
  ]);

  res.json({ success: true, data: jobs, total, page, limit });
}

export async function getJob(req: Request, res: Response): Promise<void> {
  const { workspaceId, jobId } = req.params;

  const job = await ProspectingJob.findOne({ _id: jobId, workspaceId });
  if (!job) throw ApiError.notFound('Job not found');

  res.json({ success: true, data: job });
}

export async function cancelJob(req: Request, res: Response): Promise<void> {
  const { workspaceId, jobId } = req.params;

  const job = await ProspectingJob.findOne({ _id: jobId, workspaceId });
  if (!job) throw ApiError.notFound('Job not found');

  if (['complete', 'failed', 'cancelled'].includes(job.status)) {
    throw ApiError.conflict('Job cannot be cancelled in its current state');
  }

  if (job.bullmqJobId) {
    const bullmqJob = await getProspectingQueue().getJob(job.bullmqJobId);
    await bullmqJob?.remove().catch(() => { /* job may already be active or completed */ });
  }
  job.status = 'cancelled';
  await job.save();

  res.json({ success: true, data: job });
}
