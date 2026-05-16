import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import mongoose, { Schema } from 'mongoose';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import type { SequenceStepPayload } from './sequence.worker.js';

const QUEUE_PREFIX = `{bull}:leadreai:${env.NODE_ENV}`;
const SCHEDULER_BATCH_SIZE = 200;

// Inline minimal SequenceEnrollment schema for scheduler
const enrollmentSchema = new Schema({
  workspaceId: Schema.Types.ObjectId,
  sequenceId: Schema.Types.ObjectId,
  status: String,
  currentStep: Number,
  nextStepAt: Date,
}, { strict: false });

interface IEnrollmentLean { _id: mongoose.Types.ObjectId; currentStep: number; status?: string; nextStepAt?: Date }
const EnrollmentModel = (mongoose.models['ENROLLMENT_SCHED'] as mongoose.Model<IEnrollmentLean> | undefined) ??
  mongoose.model<IEnrollmentLean>('ENROLLMENT_SCHED', enrollmentSchema, 'sequenceenrollments');

export function startSequenceScheduler(connection: Redis): { timer: NodeJS.Timeout; close: () => Promise<void> } {
  const queue = new Queue<SequenceStepPayload>('sequence-step', {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 2000 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
    },
  });

  async function tick(): Promise<void> {
    const now = new Date();
    try {
      const dueEnrollments = await EnrollmentModel.find({
        status: 'active',
        nextStepAt: { $lte: now },
      })
        .limit(SCHEDULER_BATCH_SIZE)
        .select('_id currentStep')
        .lean();

      if (dueEnrollments.length === 0) return;

      logger.info(`[scheduler] Found ${dueEnrollments.length} due enrollments`);

      const jobs = dueEnrollments.map((e) => ({
        name: 'step' as const,
        data: { enrollmentId: String(e._id), stepNumber: e.currentStep as number },
        opts: {
          jobId: `step-${String(e._id)}-${e.currentStep as number}`, // idempotent
        },
      }));

      await queue.addBulk(jobs);
    } catch (err) {
      logger.error('[scheduler] Tick error', { err });
    }
  }

  const intervalMs = env.SEQUENCE_SCHEDULER_INTERVAL_MS;
  logger.info(`[scheduler] Starting sequence scheduler (interval: ${intervalMs}ms)`);

  // Run immediately then on interval
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  return { timer, close: () => queue.close() };
}
