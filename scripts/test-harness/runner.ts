/**
 * Test-harness runner. Submits a PromptSpec as a real prospecting job, waits
 * for completion, grades it, and persists the report to disk.
 *
 * Usage:
 *   pnpm tsx --env-file=../.env scripts/test-harness/runner.ts <promptId>
 *   pnpm tsx --env-file=../.env scripts/test-harness/runner.ts p1-fintech-decision-makers
 *
 * If no promptId given, runs them all serially (expect hours of wall-clock).
 */
import mongoose from 'mongoose';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { env } from '../../src/config/env.js';
import User from '../../src/models/User.js';
import Workspace from '../../src/models/Workspace.js';
import ProspectingJob from '../../src/models/ProspectingJob.js';
import Lead from '../../src/models/Lead.js';
import { parseQuery } from '../../src/services/ai/queryParser.js';
import { dispatchProspectingJob } from '../../src/services/queue/jobDispatcher.js';
import { PROMPTS, getPromptById, type PromptSpec } from './prompts.js';
import { gradeJob, type LeadSnapshot, type GradedReport } from './grader.js';

const POLL_INTERVAL_MS = 5_000;
const JOB_TIMEOUT_MS = 70 * 60_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, 'results');

async function getOrReuseWorkspace() {
  const user = await User.findOne();
  if (!user) throw new Error('No users in DB — register via frontend first');
  const workspace = await Workspace.findOne({ ownerId: user._id }) ?? await Workspace.findOne();
  if (!workspace) throw new Error('No workspace in DB');
  return { user, workspace };
}

async function runOne(spec: PromptSpec): Promise<GradedReport> {
  console.log(`\n━━━ running: ${spec.id} ━━━\n${spec.title}\nquery: ${spec.query}\n`);

  const { user, workspace } = await getOrReuseWorkspace();

  console.log('[harness] parsing intent');
  const parsedIntent = await parseQuery(spec.query);
  // Optional override for fast baselining: HARNESS_TARGET_OVERRIDE=10 cuts a
  // "top 100 law firms" query down to a 10-lead sanity run so we can measure
  // in 10-20min instead of 60+.
  const override = process.env['HARNESS_TARGET_OVERRIDE']
    ? parseInt(process.env['HARNESS_TARGET_OVERRIDE'], 10)
    : undefined;
  if (override && Number.isFinite(override) && override > 0) {
    parsedIntent.targetCount = override;
    console.log('[harness] TARGET_OVERRIDE active — targetCount=%d (spec expected=%d)', override, spec.expectedTargetCount);
  }
  console.log('[harness] parsed: queryType=%s targetCount=%s industry=%j',
    parsedIntent.queryType, parsedIntent.targetCount, parsedIntent.industry);

  console.log('[harness] creating job + dispatching to worker queue');
  const job = await ProspectingJob.create({
    workspaceId: workspace._id,
    createdBy: user._id,
    rawQuery: spec.query,
    parsedIntent,
    status: 'queued',
    creditsCharged: 0,
  });
  const bullmqJob = await dispatchProspectingJob(job._id.toString(), workspace._id.toString());
  job.bullmqJobId = bullmqJob.id ?? undefined;
  await job.save();
  console.log('[harness] job=%s queued', job._id);

  // Poll until terminal
  const start = Date.now();
  let lastStage = '';
  let lastPct = -1;
  while (Date.now() - start < JOB_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const fresh = await ProspectingJob.findById(job._id);
    if (!fresh) throw new Error('job disappeared');
    const pct = fresh.progress?.percentage ?? 0;
    const stage = fresh.progress?.currentStage ?? 'pending';
    if (fresh.status !== lastStage || pct !== lastPct) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[harness] [t+${elapsed}s] status=${fresh.status} progress=${pct}% stage=${stage}`);
      lastStage = fresh.status;
      lastPct = pct;
    }
    if (['complete', 'failed', 'cancelled'].includes(fresh.status)) break;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leadsRaw = await Lead.find({ jobId: job._id }).lean<any[]>();
  const leads: LeadSnapshot[] = leadsRaw.map((l) => ({
    companyName: l.companyName,
    companyDomain: l.companyDomain,
    website: l.website,
    industry: l.industry,
    address: l.address,
    emails: (l.emails ?? []).map((e: { address?: string; type?: string; confidence?: number | null; source?: string }) => ({ ...e, address: e.address ?? '' })),
    phones: (l.phones ?? []).map((p: { raw?: string; normalized?: string; type?: string; countryCode?: string; source?: string }) => ({ ...p, raw: p.raw ?? '' })),
    socialProfiles: l.socialProfiles,
    contactSummary: l.contactSummary,
    sources: l.sources,
    rankScore: l.rankScore,
    completenessScore: l.completenessScore,
    tags: l.tags,
  }));

  console.log(`[harness] ${leads.length} leads persisted — grading`);
  const report = gradeJob(spec, job._id.toString(), leads, override);
  return report;
}

function persist(report: GradedReport): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = `${ts}-${report.promptId}.json`;
  const path = resolve(RESULTS_DIR, fname);
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

function printReport(report: GradedReport): void {
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log(`║ ${report.promptId}`.padEnd(68) + '║');
  console.log(`║ composite: ${report.composite}/100`.padEnd(68) + '║');
  console.log('╠═══════════════════════════════════════════════════════════════════╣');
  for (const [axis, data] of Object.entries(report.axes)) {
    console.log(`║ ${axis.padEnd(11)} ${String(data.score).padStart(3)}/100  ${data.notes[0]?.slice(0, 48) ?? ''}`.padEnd(68) + '║');
  }
  console.log('╠═══════════════════════════════════════════════════════════════════╣');
  const b = report.leadBreakdown;
  console.log(`║ leads=${report.totalLeads} bizEmail=${b.withBusinessEmail} named=${b.withNamedContact} linkedin=${b.withLinkedIn} sourced=${b.withSourcedContact}`.padEnd(68) + '║');
  console.log(`║ validPhone=${b.withValidPhone} dupePhones=${b.duplicatePhoneCount} halluDomains=${b.hallucinatedDomains}`.padEnd(68) + '║');
  if (report.redFlags.length > 0) {
    console.log('╠═══════════════════════════════════════════════════════════════════╣');
    console.log('║ RED FLAGS'.padEnd(68) + '║');
    for (const rf of report.redFlags) console.log(`║   - ${rf}`.padEnd(68) + '║');
  }
  console.log('╚═══════════════════════════════════════════════════════════════════╝');
}

async function main() {
  const targetId = process.argv[2];
  const targets: PromptSpec[] = targetId ? [getPromptById(targetId) ?? PROMPTS[0]!] : PROMPTS;

  console.log('[harness] connecting MongoDB');
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });

  const reports: GradedReport[] = [];
  for (const spec of targets) {
    try {
      const report = await runOne(spec);
      const path = persist(report);
      console.log(`[harness] saved: ${path}`);
      printReport(report);
      reports.push(report);
    } catch (err) {
      console.error(`[harness] prompt ${spec.id} failed:`, err);
    }
  }

  console.log('\n━━━ summary ━━━');
  for (const r of reports) {
    console.log(`  ${r.promptId}: composite=${r.composite}/100  leads=${r.totalLeads}`);
  }

  await mongoose.disconnect();
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
