/**
 * End-to-end verification of the outputSchema + facts pipeline.
 *
 * Submits a funding-info query, waits for the job to complete, and prints
 * per-lead facts alongside the job's outputSchema so we can see the new
 * payload format in the DB.
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import User from '../src/models/User.js';
import Workspace from '../src/models/Workspace.js';
import ProspectingJob from '../src/models/ProspectingJob.js';
import Lead from '../src/models/Lead.js';
import { parseQuery } from '../src/services/ai/queryParser.js';
import { dispatchProspectingJob } from '../src/services/queue/jobDispatcher.js';

const RAW_QUERY =
  'Get me the top 5 fintech companies to raise funding in Nigeria. Show company email, a phone number, and the amount raised.';
const POLL_MS = 5_000;
const TIMEOUT_MS = 30 * 60_000;

async function main() {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
  const user = await User.findOne();
  const workspace = await Workspace.findOne({ ownerId: user!._id }) ?? await Workspace.findOne();
  if (!user || !workspace) throw new Error('need seeded user+workspace');

  console.log('[e2e-funding] parsing query...');
  const parsedIntent = await parseQuery(RAW_QUERY);
  console.log('[e2e-funding] outputSchema:', JSON.stringify(parsedIntent.outputSchema, null, 2));
  console.log('[e2e-funding] desiredFields:', parsedIntent.desiredFields.join(', '));

  const job = await ProspectingJob.create({
    workspaceId: workspace._id,
    createdBy: user._id,
    rawQuery: RAW_QUERY,
    parsedIntent,
    status: 'queued',
    creditsCharged: 0,
  });
  const bmq = await dispatchProspectingJob(job._id.toString(), workspace._id.toString());
  job.bullmqJobId = bmq.id ?? undefined;
  await job.save();
  console.log(`[e2e-funding] job=${job._id} queued, waiting...`);

  const start = Date.now();
  let lastStage = '';
  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const fresh = await ProspectingJob.findById(job._id);
    if (!fresh) throw new Error('job disappeared');
    const stage = fresh.progress?.currentStage ?? 'pending';
    if (stage !== lastStage) {
      console.log(`[e2e-funding] [t+${Math.round((Date.now() - start) / 1000)}s] status=${fresh.status} stage=${stage}`);
      lastStage = stage;
    }
    if (['complete', 'failed', 'cancelled'].includes(fresh.status)) break;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leads = await Lead.find({ jobId: job._id }).lean<any[]>();
  console.log(`\n[e2e-funding] === ${leads.length} leads returned ===`);
  for (const l of leads) {
    console.log(`\n  ${l.companyName}  [${l.companyDomain ?? '-'}]`);
    console.log(`    emails=${(l.emails ?? []).map((e: { address: string }) => e.address).join(', ') || '-'}`);
    console.log(`    phones=${(l.phones ?? []).map((p: { normalized?: string; raw: string }) => p.normalized ?? p.raw).join(', ') || '-'}`);
    console.log(`    schemaFulfillmentPct=${l.schemaFulfillmentPct ?? 'n/a'}`);
    if (l.facts && Object.keys(l.facts).length > 0) {
      console.log(`    facts:`);
      for (const [k, v] of Object.entries(l.facts)) {
        const fv = v as { value: unknown; unit?: string; sourceUrl?: string; confidence?: number };
        const unit = fv.unit ? ` ${fv.unit}` : '';
        const conf = fv.confidence !== undefined ? ` (conf=${fv.confidence})` : '';
        const src = fv.sourceUrl ? `\n        source: ${fv.sourceUrl}` : '';
        console.log(`      ${k}: ${JSON.stringify(fv.value)}${unit}${conf}${src}`);
      }
    } else {
      console.log(`    facts: (none)`);
    }
  }

  await mongoose.disconnect();
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
