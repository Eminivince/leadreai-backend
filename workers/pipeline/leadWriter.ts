import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { Queue, QueueEvents } from 'bullmq';
import { logger } from '../utils/logger.js';
import { fireWebhook } from '../services/webhook.js';
import { env } from '../config/env.js';
import type { LeadRecord } from './deduplicator.js';
import { autoCreateFileFromJob } from './fileAutoCreator.js';
import { emitNotification } from '../services/notificationEmitter.js';
import { isSocialPlatformHost } from './tools/writeLead.js';
import { verifyEmail } from './tools/verifyEmail.js';

// ---------------------------------------------------------------------------
// Lazy contact-enrichment queue + queue events (for waitUntilFinished)
// ---------------------------------------------------------------------------
const PREFIX = `{bull}:leadreai:${env.NODE_ENV}`;

let _contactQueue: Queue | null = null;
function getContactQueue(): Queue {
  if (!_contactQueue) {
    _contactQueue = new Queue('contact-enrichment', {
      connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
      prefix: PREFIX,
    });
  }
  return _contactQueue;
}

let _contactQueueEvents: QueueEvents | null = null;
function getContactQueueEvents(): QueueEvents {
  if (!_contactQueueEvents) {
    _contactQueueEvents = new QueueEvents('contact-enrichment', {
      connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
      prefix: PREFIX,
    });
  }
  return _contactQueueEvents;
}

// Inline Lead model (strict: false — picks up all fields without re-specifying)
const leadSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
leadSchema.index({ workspaceId: 1, companyDomain: 1 }, { unique: true, sparse: true });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Lead: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Lead'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Lead', leadSchema, 'leads'); // explicit collection name

// Inline ProspectingJob model (same pattern)
const jobSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ProspectingJob: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['ProspectingJob'] as mongoose.Model<any> | undefined) ??
  mongoose.model('ProspectingJob', jobSchema);

export interface WriteLeadsSummary {
  /** Leads deleted because they had no reachable contact after enrichment. */
  prunedCount: number;
  /** Leads deleted because the surviving count exceeded targetCount. */
  trimmedCount: number;
  /** Final lead count after prune + trim, sourced from Mongo. */
  finalLeadCount: number;
}

export async function writeLeads(
  leads: LeadRecord[],
  jobId: string,
  workspaceId: string,
  publisher: Redis
): Promise<WriteLeadsSummary> {
  const channel = `job:progress:${jobId}`;
  const nonDupes = leads.filter(l => !l.isDuplicate);
  // IDs of leads we actually tried to enrich. Captured at enrichment-dispatch
  // time so the downstream verification + prune steps only operate on leads
  // that had a chance to populate emails/contacts. Without this guard, late-
  // arriving subagent leads (written after enrichment dispatch but before
  // prune) get pruned even though we never tried to find their contacts.
  const enrichedLeadIds: mongoose.Types.ObjectId[] = [];

  if (nonDupes.length === 0) {
    logger.warn('No leads to write', { jobId });
  } else {
    // Bulk upsert — match on (workspaceId, companyDomain) or insert new.
    // Empty companyDomain MUST be unset rather than set to "" — the
    // (workspaceId, companyDomain) unique index treats "" as a real value
    // and rejects multiple domain-less leads in the same workspace with
    // E11000. Setting the field via $unset lets the sparse index skip them.
    const ops = nonDupes.map(lead => {
      const hasDomain = Boolean(lead.companyDomain && lead.companyDomain.trim());
      const setFields: Record<string, unknown> = {
        ...lead,
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        jobId: new mongoose.Types.ObjectId(jobId),
      };
      // Strip Mongo-managed fields. The lead arg may already be a Mongo
      // doc (when hybridDiscovery re-reads leads after subagent enrichment),
      // and including _id / __v / createdAt in $set causes Mongo to throw
      // "Performing an update on the path '_id' would modify the immutable
      // field '_id'" when the doc already exists.
      delete setFields['_id'];
      delete setFields['__v'];
      delete setFields['createdAt'];
      if (!hasDomain) delete setFields['companyDomain'];
      const update: Record<string, unknown> = { $set: setFields };
      if (!hasDomain) update['$unset'] = { companyDomain: '' };
      return {
        updateOne: {
          filter: hasDomain
            ? { workspaceId: new mongoose.Types.ObjectId(workspaceId), companyDomain: lead.companyDomain }
            : { workspaceId: new mongoose.Types.ObjectId(workspaceId), companyName: lead.companyName },
          update,
          upsert: true,
        },
      };
    });

    const result = await Lead.bulkWrite(ops, { ordered: false });
    logger.info('Leads written', {
      jobId,
      upserted: result.upsertedCount,
      modified: result.modifiedCount,
    });

    // Dispatch contact-enrichment jobs and await their completion before
    // marking the parent job complete. Previously these jobs were fire-and-
    // forget, so the parent's `status=complete` would race ahead of the
    // enrichment that populates `contactSummary.topContact` — the harness
    // (and the UI on job-complete) would see leads with no named contacts
    // even when extraction would have found them. Awaiting costs 10-60s
    // extra per job but makes relevance scores honest.
    // Skip contact enrichment for social-platform leads (instagram.com/foo,
    // tiktok.com/bar, etc.) — there's no company site to scrape, and
    // pointing Playwright at a profile URL just burns time for no data.
    const domainsToEnrich = nonDupes
      .filter((l) => l.companyDomain)
      .map((l) => l.companyDomain!)
      .filter((d) => {
        const host = d.split('/')[0] ?? d;
        return !isSocialPlatformHost(host);
      });
    if (domainsToEnrich.length > 0) {
      const writtenLeads = await Lead.find(
        {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          companyDomain: { $in: domainsToEnrich },
        },
        { _id: 1, companyDomain: 1, companyName: 1, website: 1, emails: 1 }
      ).lean();

      // Fetch rawQuery + clarifications ONCE for the whole batch so each
      // enrichment job receives persona context. Without this the SERP
      // contact extractor defaults to broad leadership queries even when
      // the brief is "find HR managers" or "find procurement leads".
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jobMetaForPersona = await ProspectingJob.findById(jobId, {
        rawQuery: 1, parsedIntent: 1,
      }).lean() as { rawQuery?: string; parsedIntent?: { clarifications?: Array<{ question: string; answer: unknown }> } } | null;

      const personaContext = buildPersonaContext(
        jobMetaForPersona?.rawQuery,
        jobMetaForPersona?.parsedIntent?.clarifications,
      );
      const roleKeywords = extractRoleKeywords(jobMetaForPersona?.rawQuery, jobMetaForPersona?.parsedIntent?.clarifications);

      if (writtenLeads.length > 0) {
        // Record the IDs we're about to enrich. Verification + prune below
        // will use these to filter out late-arriving subagent leads that
        // never had a chance to populate emails/contacts.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const l of writtenLeads as any[]) {
          enrichedLeadIds.push(l._id as mongoose.Types.ObjectId);
        }
        const queue = getContactQueue();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dispatched = await queue.addBulk(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (writtenLeads as any[]).map((lead: any) => ({
            name: 'enrich',
            data: {
              workspaceId,
              leadId: lead._id.toString(),
              companyDomain: lead.companyDomain,
              companyName: lead.companyName,
              websiteUrl: lead.website,
              existingEmails: (lead.emails ?? []).map((e: { address: string }) => e.address),
              ...(personaContext ? { personaContext } : {}),
              ...(roleKeywords && roleKeywords.length > 0 ? { roleKeywords } : {}),
            },
          }))
        );
        logger.info('leadWriter: enqueued contact enrichment jobs', { count: dispatched.length });

        // Wait for all enrichment jobs to finish — bounded so a stuck
        // enricher can't block the parent job indefinitely. Each enricher
        // already has its own Playwright timeout; this is a belt-and-
        // suspenders ceiling.
        // The 60s/lead figure assumes Hunter call + SERP contact extraction
        // + team-page scrape can each retry once under rate limits. Cap at
        // 240s — enough for ~6-8 sequential leads at concurrency=2 (since
        // CONTACT_ENRICHMENT_CONCURRENCY defaults to 2). Earlier 120s cap
        // produced a race where late-finishing enrichers wrote to lead.
        // emails AFTER prune already deleted the lead.
        const PER_LEAD_WAIT_MS = 60_000;
        const ceilingMs = Math.min(240_000, PER_LEAD_WAIT_MS * dispatched.length);
        try {
          const events = getContactQueueEvents();
          await Promise.allSettled(
            dispatched.map((j) => j.waitUntilFinished(events, ceilingMs)),
          );
          logger.info('leadWriter: contact enrichment complete', { count: dispatched.length });
        } catch (err) {
          logger.warn('leadWriter: enrichment wait hit timeout', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // ── Mandatory email verification ────────────────────────────────────
  // Every email is run through verifyEmail() before delivery. The verifier
  // does MX lookup by default; if REACHER_URL is set, it does a full SMTP
  // RCPT handshake. Outcomes:
  //   - likely_valid   → mark verified=true, keep the email
  //   - undeliverable  → drop the email entirely
  //   - invalid_domain → drop the email entirely
  //   - risky/unknown  → keep with verified=false (user sees a guess badge)
  //
  // Without this pass, a Hunter-found work email and a regex-matched garbage
  // string read identically in the database — both have verified=false.
  // After this pass, a lead with no surviving emails feeds into the prune
  // logic below, which (combined with the inferred-only guard) is the actual
  // quality gate users feel.
  if (env.EMAIL_VERIFICATION_AT_WRITE && nonDupes.length > 0) {
    // Verify ONLY leads we actually tried to enrich. Late-arriving subagent
    // leads (written after enrichment dispatch) get verified on a future job
    // — not this one. Prevents a race where late leads with empty emails
    // skew the verified/dropped counters.
    const verifyFilter: Record<string, unknown> = {
      jobId: new mongoose.Types.ObjectId(jobId),
      isDuplicate: { $ne: true },
    };
    if (enrichedLeadIds.length > 0) verifyFilter['_id'] = { $in: enrichedLeadIds };

    const writtenLeadsForVerify = await Lead.find(
      verifyFilter,
      { _id: 1, emails: 1 }
    ).lean() as Array<{
      _id: unknown;
      emails?: Array<{ address: string; type: string; confidence: number; verified?: boolean; source: string; verifiedAt?: Date }>;
    }>;

    let verifiedCount = 0;
    let droppedCount = 0;
    const updates: Array<{ _id: unknown; emails: typeof writtenLeadsForVerify[number]['emails'] }> = [];

    for (const lead of writtenLeadsForVerify) {
      const emails = lead.emails ?? [];
      if (emails.length === 0) continue;
      const survived: NonNullable<typeof writtenLeadsForVerify[number]['emails']> = [];
      let changed = false;
      for (const e of emails) {
        // Skip already-verified to save quota / latency on re-runs
        if (e.verified === true) { survived.push(e); continue; }
        // Pattern-inferred emails are guesses (e.g. "ovalues@credpal.com"
        // pattern-extracted from a section heading like "Our values").
        // Catch-all SMTP servers return likely_valid for ANY user@domain
        // — sending these through the verifier produces false-confidence
        // verified=true labels on addresses that will bounce. Keep them
        // visible to the user as guesses, but never promote to verified.
        if (e.type === 'pattern_inferred') { survived.push(e); continue; }
        try {
          const v = await verifyEmail(e.address);
          if (v.verdict === 'undeliverable' || v.verdict === 'invalid_domain') {
            droppedCount++;
            changed = true;
            continue;
          }
          if (v.verdict === 'likely_valid') {
            verifiedCount++;
            survived.push({ ...e, verified: true, verifiedAt: new Date() });
            changed = true;
          } else {
            // risky / catch_all / unknown — keep but don't promote to verified
            survived.push({ ...e, verified: false });
          }
        } catch {
          survived.push(e); // verifier itself failed — keep email as-is
        }
      }
      if (changed) updates.push({ _id: lead._id, emails: survived });
    }

    if (updates.length > 0) {
      await Promise.all(updates.map((u) =>
        Lead.updateOne({ _id: u._id }, { $set: { emails: u.emails ?? [] } })
      ));
    }

    logger.info('writeLeads: email verification complete', {
      jobId,
      verified: verifiedCount,
      dropped: droppedCount,
      leadsAffected: updates.length,
      provider: env.EMAIL_VERIFIER_PROVIDER,
    });
  }

  // ── verifiedEmailsOnly enforcement ─────────────────────────────────
  // If the user dispatched this job with "verified emails only" selected,
  // any lead that didn't end up with at least one verified email is
  // dropped here. This runs AFTER the verification pass above, so
  // `verified: true` flags are up-to-date. It runs BEFORE the no-contact
  // prune so the prune's count metric reflects post-strictness reality.
  //
  // Note: a lead with phones but no verified email STILL gets dropped in
  // strict mode. The agency turned this on precisely because email
  // verification is the trust signal they care about — degrading to a
  // phone-only lead defeats the toggle's purpose.
  const jobStrictMode = await ProspectingJob.findById(jobId, {
    verifiedEmailsOnly: 1,
  }).lean() as { verifiedEmailsOnly?: boolean } | null;

  if (jobStrictMode?.verifiedEmailsOnly === true) {
    const unverifiedLeads = await Lead.find(
      {
        jobId: new mongoose.Types.ObjectId(jobId),
        isDuplicate: { $ne: true },
        // No element in emails[] has verified:true.
        emails: { $not: { $elemMatch: { verified: true } } },
      },
      { _id: 1, companyName: 1 }
    ).lean() as Array<{ _id: unknown; companyName?: string }>;

    if (unverifiedLeads.length > 0) {
      await Lead.deleteMany({ _id: { $in: unverifiedLeads.map(l => l._id) } });
      logger.info('writeLeads: dropped leads without verified email (verifiedEmailsOnly mode)', {
        jobId,
        count: unverifiedLeads.length,
        companies: unverifiedLeads.map(l => l.companyName).filter(Boolean),
      });
    }
  }

  // Prune leads with no reachable contact. A lead is junk when BOTH:
  //   - no email of type !== 'pattern_inferred' (a guessed address is not a contact)
  //   - no phones
  // Pattern-inferred emails alone do NOT save a lead — they're best-guess
  // strings the system has never seen in a public source. Counting them as
  // "delivered contacts" was the bug behind the recent whoweare@company.com
  // class of failures: a section heading parsed as a person name, run
  // through pattern inference, then surfaced to the user as a real email.
  //
  // contactSummary.totalContacts is intentionally NOT a survival signal —
  // we've observed it report counts that aren't backed by Contact docs
  // with reachable info (Bravura case: totalContacts=1, contacts collection
  // empty for that lead). A "named contact" without an email or phone is
  // just a name, and the user can't act on it. lead.emails and lead.phones
  // are the source of truth for reachability — if either is non-empty,
  // the lead survives.
  //
  // Runs on EVERY non-duplicate lead in the job, not just enrichedLeadIds.
  // Subagent leads with no domain bypass enrichment dispatch entirely; if
  // they also have no contact data they're junk and need to die. The earlier
  // enrichedLeadIds gate protected late-arriving subagent leads, but
  // hybridDiscovery now awaits all subagents via waitUntilFinished BEFORE
  // calling writeLeads — so every lead is on disk by the time prune runs.
  let prunedCount = 0;
  if (nonDupes.length > 0) {
    const pruneFilter: Record<string, unknown> = {
      jobId: new mongoose.Types.ObjectId(jobId),
      isDuplicate: { $ne: true },
      // No real (non-inferred) email anywhere on the lead.
      emails: { $not: { $elemMatch: { type: { $ne: 'pattern_inferred' } } } },
      'phones.0': { $exists: false },
    };

    const noContactLeads = await Lead.find(
      pruneFilter,
      { _id: 1, companyName: 1, emails: 1 }
    ).lean() as Array<{ _id: unknown; companyName?: string; emails?: Array<{ type?: string }> }>;

    if (noContactLeads.length > 0) {
      await Lead.deleteMany({ _id: { $in: noContactLeads.map(l => l._id) } });
      prunedCount = noContactLeads.length;
      const prunedNames = noContactLeads.map(l => l.companyName).filter(Boolean);
      const inferredOnly = noContactLeads.filter(l => (l.emails ?? []).length > 0).length;
      logger.info('writeLeads: pruned leads without reachable contact', {
        jobId,
        count: prunedCount,
        inferredOnly, // had pattern_inferred emails but no real ones
        zeroContact: prunedCount - inferredOnly, // had nothing at all
        companies: prunedNames,
      });
    }
  }

  // ── Post-prune trim to targetCount ─────────────────────────────────
  // Hard ceiling: the user asked for N leads, we deliver no more than N.
  // After enrichment + verification + prune, if surviving leads still
  // exceed targetCount, sort by rankScore (best first) and delete the
  // excess. This guarantees the cap regardless of how many candidates
  // the discovery sources produced.
  const jobMetaForCap = await ProspectingJob.findById(jobId, {
    'parsedIntent.targetCount': 1,
  }).lean() as { parsedIntent?: { targetCount?: number } } | null;
  const cap = Math.max(1, Math.min(10, jobMetaForCap?.parsedIntent?.targetCount ?? 10));

  const survivors = await Lead.find(
    { jobId: new mongoose.Types.ObjectId(jobId), isDuplicate: { $ne: true } },
    { _id: 1, rankScore: 1, companyName: 1, emails: 1, phones: 1 }
  ).lean() as Array<{
    _id: unknown;
    rankScore?: number;
    companyName?: string;
    emails?: Array<{ type?: string }>;
    phones?: unknown[];
  }>;

  let trimmedCount = 0;
  if (survivors.length > cap) {
    // Sort by has-contact first, rankScore second. Otherwise leads with
    // high candidate-time confidence (rankScore ≈ 70) but zero realized
    // contact info beat genuine leads with phones+emails (rankScore ≈ 55)
    // — backwards. A lead the user can't reach should never displace a
    // lead the user can reach, regardless of how confident discovery was.
    const hasContact = (l: typeof survivors[number]): boolean => {
      const realEmails = (l.emails ?? []).filter((e) => e?.type !== 'pattern_inferred');
      return realEmails.length > 0 || (l.phones?.length ?? 0) > 0;
    };
    const sorted = survivors.slice().sort((a, b) => {
      const ah = hasContact(a) ? 1 : 0;
      const bh = hasContact(b) ? 1 : 0;
      if (ah !== bh) return bh - ah;
      return (b.rankScore ?? 0) - (a.rankScore ?? 0);
    });
    const toDelete = sorted.slice(cap);
    if (toDelete.length > 0) {
      await Lead.deleteMany({ _id: { $in: toDelete.map((l) => l._id) } });
      trimmedCount = toDelete.length;
      logger.info('writeLeads: trimmed excess leads to targetCount cap', {
        jobId,
        cap,
        before: survivors.length,
        trimmed: trimmedCount,
        kept_companies: sorted.slice(0, cap).map((l) => l.companyName).filter(Boolean),
        dropped_companies: toDelete.map((l) => l.companyName).filter(Boolean),
      });
    }
  }

  // Update job to complete.
  // Authoritative count: query Mongo directly AFTER the trim.
  const finalLeadCount = await Lead.countDocuments({
    jobId: new mongoose.Types.ObjectId(jobId),
    isDuplicate: { $ne: true },
  });
  const totalLeadsFound = leads.length;
  const totalAfterDedup = finalLeadCount;

  // Decrement leadsFoundSoFar by prunedCount so the running counter on
  // the dashboard matches the post-prune reality. Without this, jobs
  // that pruned anything show inflated counts in the running display
  // even after they complete.
  const progressUpdate: Record<string, unknown> = {
    status: 'complete',
    completedAt: new Date(),
    'progress.percentage': 100,
    'progress.currentStage': 'complete',
    'result.totalLeadsFound': totalAfterDedup,
    'result.totalAfterDedup': totalAfterDedup,
  };
  // Decrement leadsFoundSoFar for both pruned (junk) and trimmed (excess)
  // leads — both reduce the displayed count. Mongo doesn't support clamp
  // in a single op so we read-modify after.
  const decrementBy = prunedCount + trimmedCount;
  if (decrementBy > 0) {
    progressUpdate['$inc'] = { 'progress.leadsFoundSoFar': -decrementBy };
  }
  // Move the $inc to a separate field outside $set
  const setFields = { ...progressUpdate };
  delete setFields['$inc'];
  const updateOp: Record<string, unknown> = { $set: setFields };
  if (decrementBy > 0) updateOp['$inc'] = { 'progress.leadsFoundSoFar': -decrementBy };

  await ProspectingJob.findByIdAndUpdate(jobId, updateOp);

  // Clamp leadsFoundSoFar to >= 0 in case the $inc went negative (subagent
  // emit-counter drift can mean prune > actual increments).
  await ProspectingJob.updateOne(
    { _id: new mongoose.Types.ObjectId(jobId), 'progress.leadsFoundSoFar': { $lt: 0 } },
    { $set: { 'progress.leadsFoundSoFar': 0 } },
  );

  // Auto-curate a File from this dispatch so the user lands with their new
  // leads already grouped. Failures are logged and non-fatal.
  await autoCreateFileFromJob(jobId, workspaceId);

  // Announce the completion in the workspace's notification feed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobMeta = (await ProspectingJob.findById(jobId, { rawQuery: 1 }).lean()) as
    | { rawQuery?: string }
    | null;
  const rawQ = jobMeta?.rawQuery?.trim();
  const preview = rawQ && rawQ.length > 60 ? `${rawQ.slice(0, 57)}…` : rawQ;
  await emitNotification({
    workspaceId,
    type: 'job.complete',
    title:
      totalAfterDedup === 0
        ? 'Dispatch filed — no qualified leads.'
        : `Dispatch filed — ${totalAfterDedup} lead${totalAfterDedup === 1 ? '' : 's'}.`,
    message: preview,
    href: `/dashboard/leads?jobId=${jobId}`,
    metadata: { jobId, totalAfterDedup, totalLeadsFound },
  });

  // Publish completion event
  await publisher.publish(
    channel,
    JSON.stringify({ type: 'complete', totalLeadsFound, totalAfterDedup })
  );

  // Fire webhook to workspace
  const ws = await mongoose.model('Workspace').findById(workspaceId, { 'settings.webhookUrl': 1 }).lean() as { settings?: { webhookUrl?: string } } | null;
  if (ws?.settings?.webhookUrl) {
    fireWebhook(ws.settings.webhookUrl, { event: 'job:complete', jobId, workspaceId, status: 'complete', totalLeadsFound }, env.WEBHOOK_TIMEOUT_MS);
  }

  logger.info('Job complete', { jobId, totalLeadsFound: totalAfterDedup, totalEnriched: totalLeadsFound, pruned: prunedCount });

  return { prunedCount, trimmedCount, finalLeadCount };
}

/**
 * Subagent-only lead write: bulk-upserts leads to Mongo without triggering
 * job completion lifecycle (status update, notifications, webhook, contact
 * enrichment). Called by subagent workers in the fan-out architecture.
 * The parent job's writeLeads call handles the full completion lifecycle.
 */
export async function writeSubagentLeads(
  leads: LeadRecord[],
  jobId: string,
  workspaceId: string,
): Promise<void> {
  const nonDupes = leads.filter(l => !l.isDuplicate);
  if (nonDupes.length === 0) return;

  // Same domain-handling discipline as writeLeads: empty companyDomain
  // must be $unset to avoid the (workspaceId, companyDomain) unique index
  // rejecting multiple domain-less leads with E11000.
  const ops = nonDupes.map(lead => {
    const hasDomain = Boolean(lead.companyDomain && lead.companyDomain.trim());
    const setFields: Record<string, unknown> = {
      ...lead,
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      jobId: new mongoose.Types.ObjectId(jobId),
    };
    // Strip Mongo-managed fields — same rationale as writeLeads.
    delete setFields['_id'];
    delete setFields['__v'];
    delete setFields['createdAt'];
    if (!hasDomain) delete setFields['companyDomain'];
    const update: Record<string, unknown> = { $set: setFields };
    if (!hasDomain) update['$unset'] = { companyDomain: '' };
    return {
      updateOne: {
        filter: hasDomain
          ? { workspaceId: new mongoose.Types.ObjectId(workspaceId), companyDomain: lead.companyDomain }
          : { workspaceId: new mongoose.Types.ObjectId(workspaceId), companyName: lead.companyName },
        update,
        upsert: true,
      },
    };
  });

  // Tolerate E11000 dupes from name-collision races between concurrent
  // subagents on the same workspace; the upsert that won is what matters.
  let upsertedCount = 0;
  let modifiedCount = 0;
  try {
    const result = await Lead.bulkWrite(ops, { ordered: false });
    upsertedCount = result.upsertedCount;
    modifiedCount = result.modifiedCount;
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    const writeErrors: Array<{ code?: number }> = e?.writeErrors ?? e?.result?.result?.writeErrors ?? [];
    const allDupes = writeErrors.length > 0 && writeErrors.every((w) => w.code === 11000);
    if (allDupes) {
      upsertedCount = e?.result?.result?.nUpserted ?? 0;
      modifiedCount = e?.result?.result?.nMatched ?? 0;
      logger.info('[subagent] tolerated E11000 dupes', {
        jobId, dupes: writeErrors.length,
      });
    } else {
      throw err;
    }
  }
  logger.info('[subagent] leads upserted', {
    jobId, upserted: upsertedCount, modified: modifiedCount,
  });
}

// ─── Persona helpers ─────────────────────────────────────────────────
// These derive persona context for the contact-enrichment pipeline so the
// SERP extractor knows whether the user wants founders, HR, sales, etc.

/**
 * Builds a one-line persona description from the user's raw brief +
 * clarification answers. The downstream LLM extractor uses this to
 * prioritise the right people from a snippet corpus.
 *
 * Returns undefined when there's nothing meaningful to convey — the
 * extractor then falls back to "most senior named individual."
 */
function buildPersonaContext(
  rawQuery?: string,
  clarifications?: Array<{ question: string; answer: unknown }>,
): string | undefined {
  const parts: string[] = [];
  if (rawQuery && rawQuery.trim()) parts.push(rawQuery.trim().slice(0, 400));
  if (clarifications && clarifications.length > 0) {
    for (const c of clarifications) {
      const ans = Array.isArray(c.answer) ? (c.answer as unknown[]).join(', ') : String(c.answer ?? '');
      if (ans.trim()) parts.push(`${c.question}: ${ans}`.slice(0, 200));
    }
  }
  if (parts.length === 0) return undefined;
  return parts.join(' | ').slice(0, 600);
}

/**
 * Extracts explicit role keywords from the user's brief so SERP queries
 * can target them directly. Pure text scan — no LLM call. Returns
 * undefined when no recognisable role mentions are found, in which case
 * the SERP extractor falls back to its broad default query set.
 *
 * The list is intentionally broad: leadership (CEO, founder, owner),
 * functional heads (head of X, VP X, X director), individual contributors
 * (manager, lead). When users want HR, sales, procurement, etc., this
 * surfaces the matching keyword so Google ranks the right pages.
 */
function extractRoleKeywords(
  rawQuery?: string,
  clarifications?: Array<{ question: string; answer: unknown }>,
): string[] | undefined {
  const corpus = [
    rawQuery ?? '',
    ...(clarifications ?? []).map((c) =>
      `${c.question} ${Array.isArray(c.answer) ? (c.answer as unknown[]).join(' ') : String(c.answer ?? '')}`,
    ),
  ].join(' ').toLowerCase();
  if (!corpus.trim()) return undefined;

  const found = new Set<string>();

  // C-suite / leadership
  const SUITE = ['ceo', 'cto', 'cfo', 'coo', 'cmo', 'chro', 'cpo', 'cio'];
  for (const t of SUITE) {
    if (new RegExp(`\\b${t}\\b`).test(corpus)) found.add(t.toUpperCase());
  }
  if (/\bfounder|co-?founder\b/.test(corpus)) found.add('founder');
  if (/\bowner|proprietor\b/.test(corpus)) found.add('owner');
  if (/\bmanaging\s+(director|partner)\b/.test(corpus)) {
    found.add('managing director');
    found.add('managing partner');
  }

  // "Head of <X>" / "VP <X>" / "<X> manager" / "<X> director"
  const headOf = corpus.match(/head of (\w+(?:\s+\w+)?)/g);
  if (headOf) for (const m of headOf) found.add(m);
  const vpOf = corpus.match(/\bvp\s+(\w+(?:\s+\w+)?)/g);
  if (vpOf) for (const m of vpOf) found.add(m.replace(/^vp/, 'VP'));
  const directorOf = corpus.match(/(\w+)\s+director\b/g);
  if (directorOf) for (const m of directorOf) found.add(m);

  // Plain functional roles when they appear as the search target
  const FUNC_ROLES = ['hr', 'human resources', 'sales', 'marketing', 'procurement', 'operations', 'finance', 'engineering', 'product', 'design', 'legal', 'compliance'];
  for (const r of FUNC_ROLES) {
    if (new RegExp(`\\b${r}\\b`).test(corpus)) {
      // Pair with "head" / "manager" for a tighter search match
      found.add(`head of ${r}`);
      found.add(`${r} manager`);
    }
  }

  if (found.size === 0) return undefined;
  return Array.from(found).slice(0, 8);
}
