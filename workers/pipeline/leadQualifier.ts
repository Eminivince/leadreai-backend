import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';
import { callLlmOnce, isLlmConfigured } from '../utils/llmClient.js';
import { env } from '../config/env.js';

// Structural shape of leads consumed by qualification — accepts both LeadRecord
// and raw Mongoose lean documents which carry the same fields.
interface QualifierLead {
  companyDomain?: string;
  companyName?: string;
  industry?: string;
  address?: { city?: string; country?: string };
  emails?: unknown[];
  phones?: unknown[];
  website?: string;
}
import type { ParsedIntent } from '../../shared/index.js';

// ---------------------------------------------------------------------------
// Inline Mongoose models (workers pattern — strict:false)
// ---------------------------------------------------------------------------

const leadSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Lead: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Lead'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Lead', leadSchema, 'leads');

const jobSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ProspectingJob: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['ProspectingJob'] as mongoose.Model<any> | undefined) ??
  mongoose.model('ProspectingJob', jobSchema);

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const QUALIFIER_SYSTEM_PROMPT = `You are a lead qualification agent for a B2B prospecting tool.

Your job is to determine whether each scraped company genuinely matches what the user searched for.
Be strict: broad SERP results often return directories, associations, international organizations, or tangentially related companies.

Rules:
- 'qualified': the company clearly matches the industry AND geography AND appears to be a real business the user would want to contact
- 'dust': the company is off-topic (wrong industry, wrong geography, a directory/association/aggregator, or has no useful contact data)
- qualificationScore: float 0.0–1.0, your confidence in the decision
- qualificationReason: ONE sentence, max 20 words, referencing a specific concrete detail

Output ONLY a valid JSON array. No markdown, no explanation:
[
  {
    "companyDomain": "example.com",
    "qualificationStatus": "qualified",
    "qualificationScore": 0.92,
    "qualificationReason": "Lagos-based commercial law firm with contact page and Nigerian Bar registration."
  }
]`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QualificationResult {
  companyDomain: string;
  qualificationStatus: 'qualified' | 'dust';
  qualificationScore: number;
  qualificationReason: string;
}

function buildUserMessage(rawQuery: string, parsedIntent: ParsedIntent | null | undefined, leads: QualifierLead[]): string {
  const industry = parsedIntent?.industry ?? 'unknown';
  const country = parsedIntent?.geography?.country ?? 'unknown';
  const city = parsedIntent?.geography?.city ?? 'unknown';
  const targetCount = parsedIntent?.targetCount ?? 'unknown';

  const leadLines = leads
    .map(
      (l) =>
        `- domain: ${l.companyDomain ?? 'unknown'}, name: ${l.companyName}, industry: ${l.industry ?? 'unknown'}, country: ${l.address?.country ?? 'unknown'}, emails: ${l.emails?.length ?? 0}, phones: ${l.phones?.length ?? 0}, website: ${l.website ?? 'none'}`
    )
    .join('\n');

  return `User searched for: "${rawQuery}"
Intent: industry=${industry}, geography=${country}/${city}, targetCount=${targetCount}

Leads to qualify:
${leadLines}`;
}

// ---------------------------------------------------------------------------
// AI call helpers
// ---------------------------------------------------------------------------

async function qualifyBatch(rawQuery: string, parsedIntent: ParsedIntent | null | undefined, leads: QualifierLead[]): Promise<QualificationResult[]> {
  const defaultQualified: QualificationResult[] = leads.map((l) => ({
    companyDomain: l.companyDomain ?? 'unknown',
    qualificationStatus: 'qualified',
    qualificationScore: 1.0,
    qualificationReason: 'Defaulted to qualified (AI qualification skipped).',
  }));

  if (!isLlmConfigured()) {
    return defaultQualified;
  }

  const result = await callLlmOnce({
    messages: [
      { role: 'system', content: QUALIFIER_SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(rawQuery, parsedIntent, leads) },
    ],
    max_tokens: 1500,
    // Lead qualification is a judgment task — use the strong model.
    // Falls back to OPENROUTER_MODEL when JUDGMENT_LLM_MODEL is unset.
    ...(env.JUDGMENT_LLM_MODEL ? { model: env.JUDGMENT_LLM_MODEL } : {}),
  }).catch((err) => {
    logger.warn('[leadQualifier] LLM fetch failed — defaulting batch to qualified', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  if (!result || !result.ok) {
    logger.warn('[leadQualifier] LLM non-OK — defaulting batch to qualified', { status: result?.status });
    return defaultQualified;
  }

  const content = result.content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Try extracting JSON array from markdown code fences
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }

  if (!Array.isArray(parsed)) {
    logger.warn('[leadQualifier] AI response is not a JSON array — defaulting batch to qualified', {
      content: content.slice(0, 200),
    });
    return defaultQualified;
  }

  // Validate each item
  const results: QualificationResult[] = [];
  for (const item of parsed) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof item.companyDomain === 'string' &&
      (item.qualificationStatus === 'qualified' || item.qualificationStatus === 'dust') &&
      typeof item.qualificationScore === 'number' &&
      typeof item.qualificationReason === 'string'
    ) {
      results.push(item as QualificationResult);
    }
  }

  if (results.length < parsed.length) {
    logger.warn('[leadQualifier] Some AI results failed schema validation — dropped', {
      expected: parsed.length,
      got: results.length,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runLeadQualifier(
  jobId: string,
  workspaceId: string,
  publisher: Redis,
): Promise<void> {
  // 1. Fetch all leads for this job
  const leads = (await Lead.find({ jobId: new mongoose.Types.ObjectId(jobId) }).lean()) as unknown as QualifierLead[];
  logger.info('[leadQualifier] Loaded leads for job', { jobId, count: leads.length });

  if (leads.length === 0) {
    logger.warn('[leadQualifier] No leads found — skipping qualification', { jobId });
    await publisher.publish(
      `job:progress:${jobId}`,
      JSON.stringify({ type: 'qualification_complete', qualified: 0, dust: 0 })
    );
    await ProspectingJob.findByIdAndUpdate(jobId, {
      'progress.percentage': 100,
      'progress.currentStage': 'qualification',
    });
    return;
  }

  // 2. Fetch job document for rawQuery + parsedIntent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobDoc = await ProspectingJob.findById(jobId).lean() as any;
  if (!jobDoc) {
    logger.warn('[leadQualifier] Job document not found — defaulting all leads to qualified', { jobId });
  }

  const rawQuery: string = jobDoc?.rawQuery ?? jobDoc?.parsedIntent?.rawQuery ?? '';
  const parsedIntent = jobDoc?.parsedIntent ?? {};

  if (!isLlmConfigured()) {
    logger.warn('[leadQualifier] LLM not configured — skipping AI qualification, marking all leads qualified', { jobId });
  }

  // 3. Batch leads into groups of 5
  const BATCH_SIZE = 5;
  const batches: (typeof leads)[] = [];
  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    batches.push(leads.slice(i, i + BATCH_SIZE));
  }

  // 4. Process each batch
  const qualificationMap = new Map<string, QualificationResult>();

  let bIdx = 0;
  for (const batch of batches) {
    bIdx++;
    logger.info('[leadQualifier] Qualifying batch', { jobId, batch: bIdx, total: batches.length, size: batch.length });

    const currentBatch = batch;
    const results = await qualifyBatch(rawQuery, parsedIntent, currentBatch).catch((err) => {
      logger.warn('[leadQualifier] qualifyBatch threw unexpectedly — defaulting batch to qualified', {
        jobId,
        err: err instanceof Error ? err.message : String(err),
      });
      return currentBatch.map((l) => ({
        companyDomain: (l as { companyDomain?: string }).companyDomain ?? 'unknown',
        qualificationStatus: 'qualified' as const,
        qualificationScore: 1.0,
        qualificationReason: 'Defaulted to qualified (AI error).',
      }));
    });

    for (const r of results) {
      qualificationMap.set(r.companyDomain, r);
    }
  }

  // 5. Build bulkWrite ops
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops: any[] = leads.map((lead: any) => {
    const domain: string = lead.companyDomain ?? 'unknown';
    const result = qualificationMap.get(domain);

    if (!result || !lead.companyDomain) {
      // No domain or not matched — default to qualified
      return {
        updateOne: {
          filter: { _id: lead._id },
          update: {
            $set: {
              qualificationStatus: 'qualified',
              qualificationScore: 1.0,
              qualificationReason: 'No domain — defaulted to qualified.',
            },
          },
        },
      };
    }

    return {
      updateOne: {
        filter: { _id: lead._id },
        update: {
          $set: {
            qualificationStatus: result.qualificationStatus,
            qualificationScore: result.qualificationScore,
            qualificationReason: result.qualificationReason,
          },
        },
      },
    };
  });

  const bulkResult = await Lead.bulkWrite(ops, { ordered: false });
  logger.info('[leadQualifier] BulkWrite complete', {
    jobId,
    modified: bulkResult.modifiedCount,
    matched: bulkResult.matchedCount,
  });

  // 6. Tally results
  const qualified = leads.filter((l) => {
    const r = qualificationMap.get(l.companyDomain ?? 'unknown');
    return !r || r.qualificationStatus === 'qualified';
  }).length;
  const dust = leads.length - qualified;

  // 7. Publish SSE event
  await publisher.publish(
    `job:progress:${jobId}`,
    JSON.stringify({ type: 'qualification_complete', qualified, dust })
  );

  // 8. Update job progress
  await ProspectingJob.findByIdAndUpdate(jobId, {
    'progress.percentage': 100,
    'progress.currentStage': 'qualification',
    $push: { 'progress.stagesComplete': 'qualification' },
  });

  logger.info('[leadQualifier] Qualification complete', { jobId, qualified, dust, total: leads.length });
}
