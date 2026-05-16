import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import SequenceEnrollment from '../models/SequenceEnrollment.js';
import Sequence from '../models/Sequence.js';
import { ApiError } from '../utils/ApiError.js';
import { ENROLLMENT_STATUSES } from '../../shared/index.js';

export async function listEnrollments(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workspaceId!)) throw ApiError.badRequest('Invalid workspaceId');
  const wsOid = new mongoose.Types.ObjectId(workspaceId);

  const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10) || 20));

  const filter: Record<string, unknown> = { workspaceId: wsOid };

  const sequenceId = req.query['sequenceId'] as string | undefined;
  if (sequenceId) {
    if (!mongoose.Types.ObjectId.isValid(sequenceId)) throw ApiError.badRequest('Invalid sequenceId');
    filter['sequenceId'] = new mongoose.Types.ObjectId(sequenceId);
  }

  const status = req.query['status'] as string | undefined;
  if (status) {
    if (!ENROLLMENT_STATUSES.includes(status as typeof ENROLLMENT_STATUSES[number])) {
      throw ApiError.badRequest(`status must be one of: ${ENROLLMENT_STATUSES.join(', ')}`);
    }
    filter['status'] = status;
  }

  const leadId = req.query['leadId'] as string | undefined;
  if (leadId) {
    if (!mongoose.Types.ObjectId.isValid(leadId)) throw ApiError.badRequest('Invalid leadId');
    filter['leadId'] = new mongoose.Types.ObjectId(leadId);
  }

  const [enrollments, total] = await Promise.all([
    SequenceEnrollment.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('leadId', 'companyName companyDomain emails'),
    SequenceEnrollment.countDocuments(filter),
  ]);
  res.json({ success: true, data: enrollments, total, page, limit });
}

export async function getEnrollment(req: Request, res: Response): Promise<void> {
  const { workspaceId, enrollmentId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workspaceId!)) throw ApiError.badRequest('Invalid workspaceId');
  const wsOid = new mongoose.Types.ObjectId(workspaceId);
  if (!enrollmentId || !mongoose.Types.ObjectId.isValid(enrollmentId)) throw ApiError.badRequest('Invalid enrollmentId');

  const enrollment = await SequenceEnrollment.findOne({ _id: enrollmentId, workspaceId: wsOid })
    .populate('leadId', 'companyName companyDomain emails')
    .populate('sequenceId', 'name steps');
  if (!enrollment) throw ApiError.notFound('Enrollment not found');
  res.json({ success: true, data: enrollment });
}

export async function pauseEnrollment(req: Request, res: Response): Promise<void> {
  const { workspaceId, enrollmentId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workspaceId!)) throw ApiError.badRequest('Invalid workspaceId');
  const wsOid = new mongoose.Types.ObjectId(workspaceId);
  if (!enrollmentId || !mongoose.Types.ObjectId.isValid(enrollmentId)) throw ApiError.badRequest('Invalid enrollmentId');

  const enrollment = await SequenceEnrollment.findOneAndUpdate(
    { _id: enrollmentId, workspaceId: wsOid, status: 'active' },
    { $set: { status: 'paused' } },
    { new: true },
  );
  if (!enrollment) throw ApiError.notFound('Active enrollment not found');
  await Sequence.updateOne(
    { _id: enrollment.sequenceId, 'stats.active': { $gt: 0 } },
    { $inc: { 'stats.active': -1 } },
  );
  res.json({ success: true, data: enrollment });
}

export async function resumeEnrollment(req: Request, res: Response): Promise<void> {
  const { workspaceId, enrollmentId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workspaceId!)) throw ApiError.badRequest('Invalid workspaceId');
  const wsOid = new mongoose.Types.ObjectId(workspaceId);
  if (!enrollmentId || !mongoose.Types.ObjectId.isValid(enrollmentId)) throw ApiError.badRequest('Invalid enrollmentId');

  const enrollment = await SequenceEnrollment.findOneAndUpdate(
    { _id: enrollmentId, workspaceId: wsOid, status: 'paused' },
    { $set: { status: 'active', nextStepAt: new Date() } },
    { new: true },
  );
  if (!enrollment) throw ApiError.notFound('Paused enrollment not found');
  await Sequence.updateOne(
    { _id: enrollment.sequenceId },
    { $inc: { 'stats.active': 1 } },
  );
  res.json({ success: true, data: enrollment });
}

export async function stopEnrollment(req: Request, res: Response): Promise<void> {
  const { workspaceId, enrollmentId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workspaceId!)) throw ApiError.badRequest('Invalid workspaceId');
  const wsOid = new mongoose.Types.ObjectId(workspaceId);
  if (!enrollmentId || !mongoose.Types.ObjectId.isValid(enrollmentId)) throw ApiError.badRequest('Invalid enrollmentId');

  const { reason } = req.body as { reason?: string };

  const enrollment = await SequenceEnrollment.findOneAndUpdate(
    { _id: enrollmentId, workspaceId: wsOid, status: { $in: ['active', 'paused'] } },
    { $set: { status: 'stopped', stopReason: reason ?? 'manual', completedAt: new Date() } },
    { new: true },
  );
  if (!enrollment) throw ApiError.notFound('Active or paused enrollment not found');

  await Sequence.updateOne(
    { _id: enrollment.sequenceId, 'stats.active': { $gt: 0 } },
    { $inc: { 'stats.active': -1 } },
  );
  res.json({ success: true, data: enrollment });
}
