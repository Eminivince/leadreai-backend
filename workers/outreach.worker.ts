import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { researchCompany, generateOutreachDraft } from './services/outreachGenerator.js';
import { runWithCostContext } from './services/costTracker.js';

// ---------------------------------------------------------------------------
// Inline Mongoose models (workers pattern — strict:false)
// ---------------------------------------------------------------------------

const leadSchema = new mongoose.Schema(
  {
    workspaceId: mongoose.Schema.Types.ObjectId,
    companyName: String,
    companyDomain: String,
    website: String,
    industry: String,
    address: { country: String, city: String, state: String },
    emails: [{ address: String, type: String }],
    phones: [{ normalized: String, type: String }],
    socialProfiles: { linkedinUrl: String },
    osint: mongoose.Schema.Types.Mixed,
  },
  { strict: false }
);

const workspaceSchema = new mongoose.Schema(
  {
    settings: { cheapMode: { type: Boolean, default: false } },
    knowledgeBase: [{ title: String, content: String, type: String }],
  },
  { strict: false }
);

const campaignSchema = new mongoose.Schema(
  {
    outreachConfig: { channel: String, tone: String, language: String },
    stats: { draftsCreated: { type: Number, default: 0 } },
    status: String,
  },
  { strict: false }
);

const outreachDraftSchema = new mongoose.Schema(
  {
    workspaceId: mongoose.Schema.Types.ObjectId,
    campaignId: mongoose.Schema.Types.ObjectId,
    leadId: mongoose.Schema.Types.ObjectId,
    firstLine: String,
    subject: String,
    body: String,
    reasoning: String,
    status: { type: String, default: 'draft' },
    channel: { type: String, default: 'email' },
  },
  { timestamps: true, strict: false }
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Lead: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Lead'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Lead', leadSchema, 'leads');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Workspace: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Workspace'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Workspace', workspaceSchema, 'workspaces');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Campaign: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Campaign'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Campaign', campaignSchema, 'campaigns');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OutreachDraft: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['OutreachDraft'] as mongoose.Model<any> | undefined) ??
  mongoose.model('OutreachDraft', outreachDraftSchema, 'outreachdrafts');

// ---------------------------------------------------------------------------
// DB connection (idempotent — skips if already connected)
// ---------------------------------------------------------------------------

async function connectDB(): Promise<void> {
  const state = mongoose.connection.readyState;
  if (state === 1) return; // already connected
  if (state === 2) {
    // connecting — wait for it
    await new Promise<void>((resolve, reject) => {
      mongoose.connection.once('connected', resolve);
      mongoose.connection.once('error', reject);
    });
    return;
  }
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  logger.info('Outreach worker MongoDB connected');
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

interface OutreachJobData {
  campaignId: string;
  workspaceId: string;
  leadIds: string[];
}

async function processOutreachJob(job: Job, publisher: Redis): Promise<void> {
  const { campaignId, workspaceId, leadIds } = job.data as OutreachJobData;

  logger.info('[outreachWorker] Job received', {
    jobId: job.id,
    campaignId,
    workspaceId,
    leadCount: leadIds.length,
  });

  // Load workspace and campaign once per job. TODO(task #8): type as IWorkspaceLean / ICampaignLean.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const [workspace, campaign] = await Promise.all([
    Workspace.findById(workspaceId).select('settings knowledgeBase name').lean() as Promise<any>,
    Campaign.findById(campaignId).select('outreachConfig').lean() as Promise<any>,
  ]);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  if (!campaign) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }

  const cheapMode: boolean = workspace.settings?.cheapMode === true; // opt-in; false by default per schema
  const hasSerpKey = Boolean(env.SERPAPI_KEY);

  logger.info('[outreachWorker] Config loaded', {
    campaignId,
    cheapMode,
    hasSerpKey,
    leadCount: leadIds.length,
  });

  // Process leads in batches of 5
  const BATCH_SIZE = 5;
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < leadIds.length; i += BATCH_SIZE) {
    const batch = leadIds.slice(i, i + BATCH_SIZE);

    type LeadResult = { leadId: string; success: true; draftId: string } | { leadId: string; success: false; error: string };

    const results = await Promise.allSettled(
      batch.map(async (leadId): Promise<LeadResult> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lead: any = await Lead.findById(leadId).lean();
        if (!lead) throw new Error(`Lead not found: ${leadId}`);

        let snippets: string[] = [];
        if (!cheapMode && hasSerpKey) {
          snippets = await researchCompany({
            companyName: lead.companyName,
            companyDomain: lead.companyDomain,
            website: lead.website,
            industry: lead.industry,
            address: lead.address,
            socialProfiles: lead.socialProfiles,
          });
        }

        const { firstLine, subject, body, reasoning } = await generateOutreachDraft(
          {
            companyName: lead.companyName,
            companyDomain: lead.companyDomain,
            website: lead.website,
            industry: lead.industry,
            address: lead.address,
            socialProfiles: lead.socialProfiles,
          },
          workspace,
          campaign,
          snippets,
        );

        const draft = await OutreachDraft.create({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          campaignId: new mongoose.Types.ObjectId(campaignId),
          leadId: new mongoose.Types.ObjectId(leadId),
          firstLine,
          subject,
          body,
          reasoning,
          status: 'draft',
          channel: 'email',
        });

        return { leadId, success: true, draftId: draft._id.toString() };
      })
    );

    // Tally and publish after batch settles (avoids doneCount race inside concurrent closures)
    let batchSuccesses = 0;
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        batchSuccesses++;
        successCount++;
        await publisher.publish(
          `outreach:progress:${campaignId}`,
          JSON.stringify({
            type: 'draft_created',
            leadId: result.value.leadId,
            draftId: result.value.draftId,
            done: successCount,
            total: leadIds.length,
          })
        );
      } else {
        failCount++;
        const leadId = result.status === 'fulfilled' ? result.value.leadId : 'unknown';
        const error = result.status === 'rejected'
          ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
          : (result.value as { error: string }).error;
        logger.warn('[outreachWorker] Lead processing failed', { leadId, campaignId, err: error });
        await publisher.publish(
          `outreach:progress:${campaignId}`,
          JSON.stringify({ type: 'lead_failed', leadId, error })
        );
      }
    }

    // Bulk $inc once per batch instead of per-lead
    if (batchSuccesses > 0) {
      await Campaign.findByIdAndUpdate(campaignId, {
        $inc: { 'stats.draftsCreated': batchSuccesses },
      });
    }
  }

  // Single final status update + completion event
  if (successCount > 0) {
    await Campaign.findByIdAndUpdate(campaignId, { status: 'active' });
  }

  await publisher.publish(
    `outreach:progress:${campaignId}`,
    JSON.stringify({
      type: 'generation_complete',
      campaignId,
      done: successCount,
      failed: failCount,
      total: leadIds.length,
    })
  );

  logger.info('[outreachWorker] Job complete', {
    campaignId,
    successCount,
    failCount,
    total: leadIds.length,
  });
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

export async function createOutreachWorker(connection: Redis, publisher: Redis): Promise<Worker> {
  await connectDB();

  const prefix = `{bull}:leadreai:${env.NODE_ENV}`;

  const worker = new Worker(
    'outreach',
    async (job: Job) => {
      try {
        const data = job.data as OutreachJobData;
        await runWithCostContext(
          { workspaceId: data.workspaceId, campaignId: data.campaignId },
          () => processOutreachJob(job, publisher),
        );
      } catch (err) {
        const data = job.data as OutreachJobData;
        const total = data.leadIds?.length ?? 0;
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[outreachWorker] Job threw before terminal publish', {
          jobId: job.id,
          campaignId: data.campaignId,
          err: msg,
        });
        await publisher.publish(
          `outreach:progress:${data.campaignId}`,
          JSON.stringify({
            type: 'generation_complete',
            campaignId: data.campaignId,
            done: 0,
            failed: total,
            total,
            fatalError: msg,
          }),
        );
        throw err;
      }
    },
    {
      connection,
      prefix,
      concurrency: env.WORKER_CONCURRENCY,
    }
  );

  worker.on('completed', (job) => {
    logger.info('[outreachWorker] Job completed', { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error('[outreachWorker] Job failed', { jobId: job?.id, err });
  });

  worker.on('error', (err) => {
    logger.error('[outreachWorker] Worker error', { err });
  });

  return worker;
}
