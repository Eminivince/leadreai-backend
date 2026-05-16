import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

// Inline File model — workers never import backend, we keep parallel schemas
// for each collection we touch. `strict: false` so we don't have to restate
// every field from the canonical backend model.
const fileSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const File: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['File'] as mongoose.Model<any> | undefined) ??
  mongoose.model('File', fileSchema);

// Inline ProspectingJob (reuse — strict:false variant matching leadWriter)
const jobSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ProspectingJob: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['ProspectingJob'] as mongoose.Model<any> | undefined) ??
  mongoose.model('ProspectingJob', jobSchema);

const leadSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Lead: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Lead'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Lead', leadSchema, 'leads');

function deriveFileName(rawQuery: string | undefined): string {
  if (!rawQuery || !rawQuery.trim()) return 'Untitled dispatch';
  const cleaned = rawQuery.trim().replace(/\s+/g, ' ');
  if (cleaned.length <= 80) return cleaned;
  return cleaned.slice(0, 77).replace(/[,;:\-\s]+$/, '') + '…';
}

/**
 * Auto-create a workspace File from a prospecting job's output.
 *
 * Called from the leadWriter after lead persistence. The file is indexed
 * uniquely on (workspaceId, sourceJobId) — a second call for the same job
 * (e.g., on a BullMQ retry) no-ops via the duplicate key path.
 *
 * If the job produced zero leads we skip the file entirely to avoid noise.
 */
export async function autoCreateFileFromJob(
  jobId: string,
  workspaceId: string,
): Promise<void> {
  try {
    // Match the same filter writeLeads uses for result.totalLeadsFound so
    // file leadCount and the displayed total agree. isDuplicate=false leads
    // are the ones the user actually sees in the leads table; the file
    // should contain the same set.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const leadDocs = (await Lead.find(
      {
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        jobId: new mongoose.Types.ObjectId(jobId),
        isDuplicate: { $ne: true },
      },
      { _id: 1 },
    ).lean()) as Array<{ _id: mongoose.Types.ObjectId }>;

    if (leadDocs.length === 0) {
      logger.info('[fileAutoCreator] no leads for job, skipping file', { jobId });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const job = (await ProspectingJob.findById(jobId, {
      rawQuery: 1,
      createdBy: 1,
    }).lean()) as { rawQuery?: string; createdBy?: mongoose.Types.ObjectId } | null;
    if (!job) {
      logger.warn('[fileAutoCreator] job vanished before file creation', { jobId });
      return;
    }

    const name = deriveFileName(job.rawQuery);

    const leadIds = leadDocs.map((l) => l._id);

    await File.findOneAndUpdate(
      {
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        sourceJobId: new mongoose.Types.ObjectId(jobId),
      },
      {
        $setOnInsert: {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          createdBy: job.createdBy,
          name,
          source: 'job',
          sourceJobId: new mongoose.Types.ObjectId(jobId),
        },
        $set: {
          leadIds, // refresh on each call — retries should see the latest set
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    logger.info('[fileAutoCreator] file upserted', { jobId, leadCount: leadIds.length, name });
  } catch (err) {
    // Never break the parent job because a file couldn't be created. The
    // leads are saved; the user can manually curate if auto-create fails.
    logger.warn('[fileAutoCreator] failed (non-fatal)', {
      jobId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
