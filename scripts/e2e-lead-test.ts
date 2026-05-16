/**
 * End-to-end test: submits a real prospecting job, waits for workers to process it,
 * and prints the resulting leads. Requires workers running in a separate process.
 *
 * Run: pnpm tsx --env-file=../.env scripts/e2e-lead-test.ts
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import User from '../src/models/User.js';
import Workspace from '../src/models/Workspace.js';
import ProspectingJob from '../src/models/ProspectingJob.js';
import Lead from '../src/models/Lead.js';
import { parseQuery } from '../src/services/ai/queryParser.js';
import { dispatchProspectingJob } from '../src/services/queue/jobDispatcher.js';

const RAW_QUERY = 'email and phone number of the top 10 law firms in Nigeria';
const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 70 * 60_000; // 70 min — matches new dynamic wall-clock cap (60 min) with slack

async function getOrCreateWorkspace() {
  // Reuse any existing user+workspace in this dev DB — we don't need auth since
  // the script calls dispatchProspectingJob directly, not the HTTP endpoint.
  const user = await User.findOne();
  if (!user) {
    throw new Error('No users in dev DB — register via the frontend first.');
  }
  const workspace = await Workspace.findOne({ ownerId: user._id }) ?? await Workspace.findOne();
  if (!workspace) {
    throw new Error('No workspace in dev DB — create one via the frontend first.');
  }
  return { user, workspace };
}

async function main() {
  console.log('[e2e] connecting to MongoDB at %s', env.MONGODB_URI);
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });

  const { user, workspace } = await getOrCreateWorkspace();
  console.log('[e2e] workspace=%s user=%s', workspace._id, user._id);

  console.log('[e2e] parsing query: %j', RAW_QUERY);
  const parsedIntent = await parseQuery(RAW_QUERY);
  console.log('[e2e] parsed intent:\n%s', JSON.stringify(parsedIntent, null, 2));

  console.log('[e2e] creating ProspectingJob');
  const job = await ProspectingJob.create({
    workspaceId: workspace._id,
    createdBy: user._id,
    rawQuery: RAW_QUERY,
    parsedIntent,
    status: 'queued',
    creditsCharged: 0,
  });
  console.log('[e2e] job created: %s', job._id);

  console.log('[e2e] dispatching to queue...');
  const bullmqJob = await dispatchProspectingJob(job._id.toString(), workspace._id.toString());
  job.bullmqJobId = bullmqJob.id ?? undefined;
  await job.save();
  console.log('[e2e] queued bullmqJobId=%s — waiting for worker to pick it up', job.bullmqJobId);

  const start = Date.now();
  let lastStatus = '';
  let lastProgressPct = -1;
  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const fresh = await ProspectingJob.findById(job._id);
    if (!fresh) {
      console.error('[e2e] job disappeared!');
      break;
    }
    const pct = fresh.progress?.percentage ?? 0;
    const step = fresh.progress?.currentStep ?? 'pending';
    if (fresh.status !== lastStatus || pct !== lastProgressPct) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[e2e] [t+${elapsed}s] status=${fresh.status} progress=${pct}% step=${step}`);
      lastStatus = fresh.status;
      lastProgressPct = pct;
    }

    if (['complete', 'failed', 'cancelled'].includes(fresh.status)) {
      console.log('\n[e2e] === Job final status: %s ===', fresh.status);
      if (fresh.errorMessage) console.log('[e2e] error: %s', fresh.errorMessage);
      if (fresh.activityLog && fresh.activityLog.length > 0) {
        console.log('\n[e2e] Last 15 activity log entries:');
        for (const entry of fresh.activityLog.slice(-15)) {
          console.log('  - [%s] %s', entry.step, entry.message);
        }
      }

      const leads = await Lead.find({ jobId: fresh._id }).sort({ rankScore: -1 }).limit(20);
      console.log('\n[e2e] === %d lead(s) found ===', leads.length);
      for (const lead of leads) {
        console.log(`\n  Company: ${lead.companyName}`);
        if (lead.companyDomain) console.log(`  Domain:  ${lead.companyDomain}`);
        if (lead.website) console.log(`  Website: ${lead.website}`);
        if (lead.address?.country || lead.address?.city) {
          console.log(`  Location: ${[lead.address.city, lead.address.state, lead.address.country].filter(Boolean).join(', ')}`);
        }
        if (lead.industry) console.log(`  Industry: ${lead.industry}`);
        if (lead.emails && lead.emails.length > 0) {
          console.log(`  Emails (${lead.emails.length}):`);
          for (const e of lead.emails.slice(0, 5)) {
            console.log(`    - ${e.address} (${e.type}, confidence=${e.confidence}, verified=${e.verified})`);
          }
        }
        if (lead.phones && lead.phones.length > 0) {
          console.log(`  Phones (${lead.phones.length}):`);
          for (const p of lead.phones.slice(0, 5)) {
            console.log(`    - ${p.raw}${p.normalized ? ` [${p.normalized}]` : ''}`);
          }
        }
        if (lead.contactSummary?.topContact) {
          const c = lead.contactSummary.topContact;
          console.log(`  Top contact: ${c.fullName}${c.title ? ` — ${c.title}` : ''} (${c.seniority})`);
        }
        console.log(`  Scores: rank=${lead.rankScore} completeness=${lead.completenessScore} qualification=${lead.qualificationStatus}`);
      }
      break;
    }
  }

  if (Date.now() - start >= TIMEOUT_MS) {
    console.error('[e2e] TIMEOUT — job did not complete within %d ms', TIMEOUT_MS);
  }

  await mongoose.disconnect();
}

main()
  .then(() => { process.exit(0); })
  .catch((err) => {
    console.error('[e2e] unhandled error:', err);
    process.exit(1);
  });
