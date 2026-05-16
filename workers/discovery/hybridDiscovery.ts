/**
 * Hybrid Discovery Pipeline
 *
 * Replaces the dispatcher agent loop with a single LLM call that proposes
 * candidate companies from training knowledge, validates them cheaply, then
 * hands survivors to the existing subagent enrichment logic.
 *
 *   Step 1 — Single LLM discovery call (OpenRouter, no retries)
 *   Step 2 — Parallel DNS + HTTP validation gate
 *   Step 3 — Fan-out to existing subagent enrichment (one BullMQ job per candidate)
 *   Step 4 — Gather leads from MongoDB, attach fitReason/signals, rank, write
 */

import mongoose from 'mongoose';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { callLlmOnce } from '../utils/llmClient.js';
import { jobActivity } from '../pipeline/intentParser.js';
import { rankLeads } from '../pipeline/ranker.js';
import { writeLeads } from '../pipeline/leadWriter.js';
import { buildDiscoveryPrompt } from './discoveryPrompt.js';
import { discoverFromDirectories } from './directoryDiscovery.js';
import { discoverFromGoogleMaps } from './googleMapsDiscovery.js';
import { discoverFromNairaland } from './nairalandDiscovery.js';
import { validateCandidates, type RawCandidate } from './validateCandidates.js';
import { filterHouseholdNames } from './householdNameFilter.js';
import { generateLeadReasons } from './leadReasoner.js';
import type { JobAgentInput, JobAgentResult } from '../pipeline/jobAgent.js';
import type { ProspectingSubagentJobData, HybridCandidate } from '../pipeline/jobSubagent.js';
import type { LeadRecord } from '../pipeline/deduplicator.js';

const SUBAGENT_QUEUE_PREFIX = `{bull}:leadreai:${env.NODE_ENV}`;
const GATHER_TIMEOUT_MS = 300_000; // 5 min — subagents can take 3-4 min when rate-limited

// ── Minimal Mongo models (same lazy-registration pattern as jobAgent.ts) ──────

const _leadSchema = new mongoose.Schema({}, { strict: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LeadModel: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Lead'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Lead', _leadSchema, 'leads');

const _pjSchema = new mongoose.Schema({}, { strict: false });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PJModel: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['ProspectingJob'] as mongoose.Model<any> | undefined) ??
  mongoose.model('ProspectingJob', _pjSchema, 'prospectingjobs');

async function queryLeads(jobId: string): Promise<LeadRecord[]> {
  const docs = await LeadModel.find({
    jobId: new mongoose.Types.ObjectId(jobId),
    isDuplicate: { $ne: true },
  }).lean();
  return docs as unknown as LeadRecord[];
}

// ── Lazy subagent queue + queue-events (for waitUntilFinished) ───────────────

let _queue: Queue | null = null;
function getSubagentQueue(): Queue {
  if (!_queue) {
    _queue = new Queue('prospecting-subagent', {
      connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
      prefix: SUBAGENT_QUEUE_PREFIX,
      defaultJobOptions: { removeOnComplete: { count: 200 }, removeOnFail: { count: 50 } },
    });
  }
  return _queue;
}

let _queueEvents: QueueEvents | null = null;
function getSubagentQueueEvents(): QueueEvents {
  if (!_queueEvents) {
    _queueEvents = new QueueEvents('prospecting-subagent', {
      connection: new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
      prefix: SUBAGENT_QUEUE_PREFIX,
    });
  }
  return _queueEvents;
}

// ── JSON repair helper ────────────────────────────────────────────────────────

/**
 * Replaces single-quote characters used as JSON structural delimiters
 * (string opener/closer) with double quotes, while leaving apostrophes
 * that appear inside already-valid double-quoted strings untouched.
 *
 * Example broken output: {"candidates':[{"name":"Acme",...}]}
 * Fixed output:          {"candidates":[{"name":"Acme",...}]}
 */
function repairStructuralSingleQuotes(s: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\' && inString) {
      // Escaped character inside a string — copy both chars and skip ahead
      out += ch + (s[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
    } else if (ch === "'" && !inString) {
      // Single quote in structural position — replace with double quote
      out += '"';
    } else {
      out += ch;
    }
    i++;
  }
  return out;
}

/**
 * Repairs a JSON object that was truncated mid-array (model hit max_tokens).
 * Finds the last complete top-level candidate object — the one whose closing
 * "}" can be found before the string ends — and closes the array + wrapper.
 *
 * Input:  {"candidates":[{"name":"A",...},{"name":"B","domain":"b.com"
 * Output: {"candidates":[{"name":"A",...}]}
 */
function repairTruncatedCandidateArray(s: string): string {
  // Find the outermost { ... } pair (the wrapper object)
  const wrapperStart = s.indexOf('{');
  if (wrapperStart === -1) return s;

  // Find the opening of the candidates array
  const arrStart = s.indexOf('[', wrapperStart);
  if (arrStart === -1) return s;

  // Walk the array collecting complete objects (depth goes 0→1→0 per entry)
  let lastCompleteEnd = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = arrStart + 1; i < s.length; i++) {
    const ch = s[i]!;
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) lastCompleteEnd = i; // end of a complete candidate
    } else if (ch === ']' && depth === 0) {
      return s; // already valid — nothing to repair
    }
  }

  if (lastCompleteEnd === -1) return s; // no complete candidate found
  // Close the array and wrapper object after the last complete entry
  return s.slice(0, lastCompleteEnd + 1) + ']}';
}

// ── Step 1: Single LLM discovery call (via existing OpenRouter client) ────────

async function callDiscovery(prompt: string): Promise<RawCandidate[]> {
  // Two-stage attempt: first try DISCOVERY_LLM_MODEL (typically v4-pro for
  // its better instruction-following on disqualifiers), then fall back to
  // OPENROUTER_MODEL (typically v3-chat) if v4-pro returns empty content
  // or errors. v4-pro on OpenRouter occasionally returns 200 OK with no
  // body when the upstream provider is overloaded — the fallback prevents
  // a transient v4-pro hiccup from killing the entire job.
  // 300s ceiling: v4-pro can take 2-4 minutes generating 30 candidates.
  const baseRequest = {
    messages: [
      {
        role: 'system',
        content: 'Output ONLY valid JSON. No markdown fences, no prose, no preamble. Your entire response must be parseable by JSON.parse().',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens: 5500,
    temperature: 0,
    response_format: { type: 'json_object' as const },
    timeoutMs: 300_000,
  };

  let result = await callLlmOnce({ ...baseRequest, model: env.DISCOVERY_LLM_MODEL });

  // Retry with the default OPENROUTER_MODEL when v4-pro returns empty
  // (the OpenRouter upstream-overloaded failure mode) or 5xx.
  const isEmpty = result.ok && !result.content;
  const isServerError = !result.ok && result.status >= 500;
  if (env.DISCOVERY_LLM_MODEL && (isEmpty || isServerError)) {
    logger.warn('[hybridDiscovery] discovery model returned empty/5xx — falling back to OPENROUTER_MODEL', {
      primary: env.DISCOVERY_LLM_MODEL, status: result.status, empty: isEmpty,
    });
    result = await callLlmOnce({ ...baseRequest });
  }

  if (!result.ok) {
    throw new Error(
      `[hybridDiscovery] LLM returned HTTP ${result.status} — check OPENROUTER_API_KEY and DISCOVERY_LLM_MODEL availability`,
    );
  }
  if (!result.content) {
    throw new Error(
      `[hybridDiscovery] LLM returned HTTP 200 but empty content — ` +
      `DISCOVERY_LLM_MODEL=${env.DISCOVERY_LLM_MODEL ?? '(using OPENROUTER_MODEL)'} may be invalid or unavailable`,
    );
  }

  // Strip markdown fences if the model added them despite instructions
  const cleaned = result.content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  let repaired = false;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Some models output single quotes as string delimiters instead of double
    // quotes (e.g. "candidates': [" instead of "candidates": [).
    // Try a structural single→double quote repair before giving up.
    // Only replaces ' characters that are NOT inside existing "..." strings,
    // so apostrophes inside description/fitReason text are preserved.
    const patched = repairStructuralSingleQuotes(cleaned);
    try {
      parsed = JSON.parse(patched);
      repaired = true;
      logger.info('[hybridDiscovery] repaired single-quote JSON from LLM');
    } catch {
      // Last-ditch: the model hit max_tokens mid-array, leaving truncated JSON.
      // Find the last complete {...} object in the candidates array and close
      // the structure so we salvage whatever candidates were fully generated.
      const truncRepaired = repairTruncatedCandidateArray(cleaned);
      try {
        parsed = JSON.parse(truncRepaired);
        repaired = true;
        logger.warn('[hybridDiscovery] salvaged truncated JSON response — partial candidate list');
      } catch {
        throw new Error(
          `[hybridDiscovery] discovery response is not valid JSON:\n${cleaned.slice(0, 500)}`,
        );
      }
    }
  }
  void repaired; // used only for the log above

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = parsed as any;

  // Some models wrap the array differently — try common key names first,
  // then fall back to the first array-valued key found in the object.
  const KNOWN_KEYS = ['candidates', 'companies', 'results', 'data', 'list', 'output', 'leads', 'matches'];
  let candidateArray: unknown[] = Array.isArray(raw) ? raw : [];
  if (candidateArray.length === 0 && typeof raw === 'object' && raw !== null) {
    for (const key of KNOWN_KEYS) {
      if (Array.isArray((raw as Record<string, unknown>)[key])) {
        candidateArray = (raw as Record<string, unknown>)[key] as unknown[];
        break;
      }
    }
    // Last-resort: first array-valued key in the object
    if (candidateArray.length === 0) {
      for (const val of Object.values(raw as Record<string, unknown>)) {
        if (Array.isArray(val) && val.length > 0) {
          candidateArray = val;
          break;
        }
      }
    }
  }

  // Always log the raw response shape so we can diagnose model output issues
  logger.info('[hybridDiscovery] raw response shape', {
    rawType: Array.isArray(raw) ? 'array' : typeof raw,
    keys: typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? Object.keys(raw) : undefined,
    candidateArrayLength: candidateArray.length,
    rawResponsePreview: cleaned.slice(0, 600),
  });

  // Filter out structurally invalid entries — drop and log, don't throw.
  // Domain is OPTIONAL: small Nigerian SMEs (esp. food vendors / bukkas /
  // mama puts) often have no website at all. The LLM correctly emits
  // `domain: null` for those. We accept these as domain-less candidates
  // and let the subagent search for a footprint downstream.
  const valid: RawCandidate[] = [];
  for (const c of candidateArray) {
    const entry = c as Record<string, unknown>;
    const entryName = entry?.name;
    if (typeof entryName !== 'string' || entryName.trim() === '') {
      logger.warn('[hybridDiscovery] skipping malformed candidate from LLM (no name)', { entry: c });
      continue;
    }
    // Normalise domain: accept string, null, undefined, or empty string.
    // null/undefined/'' all become '' which the validator skips DNS for.
    const rawDomain = typeof entry.domain === 'string' ? entry.domain.trim() : '';
    const cleanDomain = rawDomain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const hasDomain = Boolean(cleanDomain && cleanDomain.includes('.'));
    // Optional likelyContact — only kept when shape is valid (name is a
    // 2+ word string). Hallucinated/single-word names are silently dropped
    // so a downstream subagent isn't misled by guesses.
    let likelyContact: HybridCandidate['likelyContact'];
    if (entry.likelyContact && typeof entry.likelyContact === 'object') {
      const lc = entry.likelyContact as Record<string, unknown>;
      const lcName = typeof lc.name === 'string' ? lc.name.trim() : '';
      if (lcName && lcName.split(/\s+/).filter(Boolean).length >= 2) {
        likelyContact = {
          name: lcName,
          title: typeof lc.title === 'string' ? lc.title.trim().slice(0, 120) : undefined,
          sourceHint: typeof lc.sourceHint === 'string' ? lc.sourceHint.trim().slice(0, 200) : undefined,
        };
      }
    }
    const confidenceRaw = entry.confidence;
    const confidence: 'high' | 'medium' | 'low' =
      confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
        ? confidenceRaw
        : 'medium';
    valid.push({
      name: entryName.trim(),
      domain: hasDomain ? cleanDomain! : '',
      description: typeof entry.description === 'string' ? entry.description : '',
      fitReason: typeof entry.fitReason === 'string' ? entry.fitReason : '',
      confidence,
      signals: Array.isArray(entry.signals)
        ? (entry.signals as unknown[]).filter((s): s is string => typeof s === 'string')
        : [],
      ...(hasDomain ? {} : { domainUnverified: true }),
      ...(likelyContact ? { likelyContact } : {}),
    });
  }

  if (valid.length === 0) {
    logger.warn('[hybridDiscovery] 0 valid candidates after parsing', {
      candidateArrayLength: candidateArray.length,
      rawResponseFull: cleaned.slice(0, 1200),
    });
  }

  return valid;
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function runHybridDiscovery(input: JobAgentInput): Promise<JobAgentResult> {
  const { jobId, workspaceId, parsedIntent, rawQuery, clarifications, publisher } = input;
  const targetCount = parsedIntent.targetCount ?? 10;
  const t0 = Date.now();

  logger.info('[hybridDiscovery] starting', { jobId, targetCount });

  await jobActivity(jobId, publisher, 'tool_call', 'Generating candidate companies…', {});

  // ── Step 1: Discovery call ──────────────────────────────────────────────────
  // Small additive buffer. With Maps shipping seed phones and the DNS
  // gate catching hallucinations, attrition is now low enough that a +2
  // buffer suffices. The previous 1.4× multiplier produced 14 candidates
  // for a target of 10 → 14 leads delivered → cap silently violated.
  // Combined with the post-prune trim in writeLeads, this bounds total
  // output to exactly targetCount.
  const candidateTarget = targetCount + 2;

  // Source pick: fan out to all open-web discovery sources whenever the
  // brief is filter-style (demographic_filter) OR a top-N brief with no
  // specific company names provided (named_entity_list with empty
  // namedEntities). The latter case includes briefs like "find 5 popular
  // bukkas in Surulere" — the parser tags those as named_entity_list
  // because the user said "find N", but the actual companies are unknown
  // long-tail SMEs that Maps/directories/Nairaland index and the LLM
  // doesn't recall by name. Routing them through LLM-only would miss
  // every real result.
  //
  // Each external source has different strengths:
  //   - directoryDiscovery: paid Nigerian business directories (small SMEs)
  //   - googleMapsDiscovery: any geo-tagged business + structured phones
  //   - nairalandDiscovery: free-text mentions in forum threads (the
  //     long tail beyond directories — "best mama put in Surulere")
  //
  // LLM-recall augments only when the parallel sources together return
  // fewer than targetCount candidates. We keep contact_lookup on the
  // LLM-only path because that flow already targets a specific named
  // company — Maps/directory queries against the brief's keywords would
  // surface unrelated competitors.
  const hasNamedEntities = (parsedIntent.namedEntities?.length ?? 0) > 0;
  const useExternalDiscovery = parsedIntent.queryType === 'demographic_filter'
    || (parsedIntent.queryType === 'named_entity_list' && !hasNamedEntities);
  let rawCandidates: RawCandidate[] = [];

  if (useExternalDiscovery) {
    const [dirRes, mapsRes, nairaRes] = await Promise.allSettled([
      discoverFromDirectories(parsedIntent, rawQuery ?? '', candidateTarget),
      discoverFromGoogleMaps(parsedIntent, rawQuery ?? '', candidateTarget),
      discoverFromNairaland(parsedIntent, rawQuery ?? '', candidateTarget),
    ]);

    const dir = dirRes.status === 'fulfilled' ? dirRes.value : [];
    const maps = mapsRes.status === 'fulfilled' ? mapsRes.value : [];
    const naira = nairaRes.status === 'fulfilled' ? nairaRes.value : [];

    // Source-priority dedup by lowercased name. Maps wins ties because
    // it carries seed phones. Directories are runner-up (real listings).
    // Nairaland fills the long tail.
    const seen = new Set<string>();
    const merged: RawCandidate[] = [];
    for (const c of [...maps, ...dir, ...naira]) {
      const key = c.name.toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c as RawCandidate);
    }
    rawCandidates = merged;

    logger.info('[hybridDiscovery] external discovery yield', {
      jobId,
      directories: dir.length,
      googleMaps: maps.length,
      nairaland: naira.length,
      total_after_dedup: rawCandidates.length,
      target: candidateTarget,
      sources_threw: {
        directories: dirRes.status === 'rejected',
        googleMaps: mapsRes.status === 'rejected',
        nairaland: nairaRes.status === 'rejected',
      },
    });
  }

  // LLM-recall augmentation runs whenever directory yielded fewer than
  // targetCount candidates. The DNS gate downstream catches any
  // hallucinated companies the LLM invents — a fake LLM-named company
  // with a fake domain fails DNS and is dropped at validation. Real
  // directory candidates pass through unchanged. So combining sources is
  // safe: directory contributes long-tail SMEs, LLM-recall contributes
  // press-known companies, hallucinations get filtered.
  const shouldAugmentWithLLM = rawCandidates.length < targetCount;
  if (shouldAugmentWithLLM) {
    const prompt = buildDiscoveryPrompt({
      parsedIntent: { ...parsedIntent, targetCount: candidateTarget },
      rawQuery: rawQuery ?? '',
      clarifications,
    });

    try {
      const llmCandidates = await callDiscovery(prompt);
      // Dedupe by lowercased name — directory + LLM may overlap on
      // larger SMEs that have both directory listings AND press coverage.
      const seen = new Set(rawCandidates.map((c) => c.name.toLowerCase().trim()));
      let added = 0;
      for (const c of llmCandidates) {
        const key = c.name.toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        rawCandidates.push(c);
        added++;
      }
      logger.info('[hybridDiscovery] LLM-recall augmentation', {
        jobId, directory_count: rawCandidates.length - added, llm_added: added, total: rawCandidates.length,
      });
    } catch (err) {
      // LLM-recall failure is non-fatal when directory already produced
      // some candidates. Only fall back to dispatcher when we have nothing.
      if (rawCandidates.length === 0) {
        logger.warn('[hybridDiscovery] LLM-recall failed and directory yielded zero', {
          jobId, err: err instanceof Error ? err.message : String(err),
        });
        return {
          leads: [], stepsUsed: 1, stopReason: 'error',
          transcript: [`Hybrid: discovery call failed — falling back to old pipeline`],
          fanOutComplete: false, leadsFound: 0, fallbackToOld: true,
        };
      }
      logger.warn('[hybridDiscovery] LLM-recall failed but keeping directory candidates', {
        jobId, directory_count: rawCandidates.length,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const discovery_ms = Date.now() - t0;
  logger.info('[hybridDiscovery] discovery complete', {
    jobId, candidates_proposed: rawCandidates.length, discovery_ms,
  });

  if (rawCandidates.length === 0) {
    logger.warn('[hybridDiscovery] 0 candidates — signalling fallback to dispatcher', { jobId, discovery_ms });
    return {
      leads: [], stepsUsed: 1, stopReason: 'error',
      transcript: ['Hybrid: 0 candidates from LLM — falling back to old pipeline'],
      fanOutComplete: false, leadsFound: 0, fallbackToOld: true,
    };
  }

  await jobActivity(
    jobId, publisher, 'tool_call',
    `Validating ${rawCandidates.length} candidates…`,
    { count: rawCandidates.length },
  );

  // ── Step 2: Validation gate ─────────────────────────────────────────────────
  const t1 = Date.now();
  const { valid, dropped, stats } = await validateCandidates(rawCandidates);
  const validation_ms = Date.now() - t1;

  logger.info('[hybridDiscovery] validation complete', {
    jobId,
    candidates_validated: valid.length,
    candidates_dropped: dropped.length,
    drop_reasons: {
      domain_invalid: stats.domain_invalid,
      dns_fail: stats.dns_fail,
      http_unreachable: stats.http_unreachable,
      low_confidence_fail: stats.low_confidence_fail,
    },
    validation_ms,
  });

  if (dropped.length > 0) {
    logger.info('[hybridDiscovery] dropped candidates', {
      jobId,
      dropped: dropped.map(d => ({ domain: d.candidate.domain, reason: d.reason })),
    });
  }

  if (valid.length === 0) {
    throw new Error(
      `[hybridDiscovery] all ${rawCandidates.length} candidates failed validation — ` +
      `check drop reasons: dns_fail=${stats.dns_fail}, low_confidence_fail=${stats.low_confidence_fail}`,
    );
  }

  // ── Step 2.5: Household-name filter (optional) ──────────────────────────────
  // When the user's brief excluded prominent companies, run a focused
  // judgment pass to drop household / well-known names that the discovery
  // model returned despite the prompt's COUNTERACT BIAS rule. Cheap
  // (~$0.005/job) and fail-open: a transient LLM failure keeps every
  // candidate rather than dropping the batch.
  let householdDropped: Array<{ candidate: HybridCandidate; reason: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((parsedIntent as any).excludeWellKnown === true && valid.length > 0) {
    const country = parsedIntent.geography?.country ?? 'Nigeria';
    const result = await filterHouseholdNames(valid, country);
    householdDropped = result.dropped;
    if (result.dropped.length > 0) {
      // Replace `valid` so downstream stages only see the kept candidates.
      valid.length = 0;
      valid.push(...result.kept);
    }
  }

  // Build domain → candidate map for fitReason/signals attachment in Step 4
  const candidateMap = new Map<string, HybridCandidate>(
    valid.map(c => [c.domain.toLowerCase(), c]),
  );

  // ── Step 3: Fan-out to subagents ────────────────────────────────────────────
  const t2 = Date.now();
  const subagentBudget = { maxSteps: 20, wallClockMs: 90_000 };

  await PJModel.findByIdAndUpdate(jobId, {
    $set: { 'subagentStats.dispatched': valid.length },
  }).catch(() => {});

  // Dispatch all validated candidates as subagent jobs. Capture the Job
  // handles so we can wait for ALL of them to finish — the previous
  // count-poll-and-early-exit pattern let late subagents write leads
  // after the parent had moved on, producing count drift between
  // result.totalLeadsFound, file leadCount, and Lead.find().
  const dispatchedJobs = await getSubagentQueue().addBulk(
    valid.map(c => ({
      name: c.name,
      data: {
        parentJobId: jobId,
        workspaceId,
        candidate: { companyName: c.name, companyDomain: c.domain, hints: [c.description] },
        parsedIntent,
        rawQuery,
        clarifications,
        budget: subagentBudget,
        mode: 'hybrid',
        hybridCandidate: c,
      } satisfies ProspectingSubagentJobData,
    })),
  );

  await jobActivity(
    jobId, publisher, 'tool_call',
    `Enriching ${valid.length} validated companies…`,
    { dispatched: valid.length },
  );

  // ── Step 4: Wait for ALL subagents → rank → write ──────────────────────────
  // Wait for every dispatched subagent to finish (bounded by GATHER_TIMEOUT_MS
  // as a safety ceiling). This eliminates the late-write race that previously
  // caused result.totalLeadsFound to disagree with the actual lead count in
  // the table — every lead this job is going to produce is written before we
  // proceed to writeLeads.
  let timedOut = false;
  const events = getSubagentQueueEvents();
  const waitResults = await Promise.allSettled(
    dispatchedJobs.map((j) => j.waitUntilFinished(events, GATHER_TIMEOUT_MS)),
  );
  const finished = waitResults.filter((r) => r.status === 'fulfilled').length;
  const stuckOrFailed = waitResults.length - finished;
  if (stuckOrFailed > 0) {
    timedOut = true;
    logger.info('[hybridDiscovery] some subagents did not finish in time', {
      jobId, finished, stuck_or_failed: stuckOrFailed, ceilingMs: GATHER_TIMEOUT_MS,
    });
  }
  logger.info('[hybridDiscovery] all subagents settled', {
    jobId, dispatched: dispatchedJobs.length, finished,
  });

  const enrichment_ms = Date.now() - t2;

  // Read leads from MongoDB, attach fitReason + signals from the candidate map
  const rawLeads = await queryLeads(jobId);
  const leadsWithMeta: LeadRecord[] = rawLeads.map(lead => {
    const domain = lead.companyDomain?.toLowerCase();
    const candidate = domain ? candidateMap.get(domain) : undefined;
    if (!candidate) return lead;
    return {
      ...lead,
      fitReason: candidate.fitReason,
      signals: candidate.signals,
      // Merge candidate signals into existing tags without duplicating
      tags: [...new Set([...(lead.tags ?? []), ...candidate.signals, 'hybrid_discovery'])],
    };
  });

  const ranked = rankLeads(leadsWithMeta, parsedIntent.desiredFields);

  const writeSummary = await writeLeads(ranked, jobId, workspaceId, publisher);

  // Final pass: generate brief-relevant per-lead reasons for the leads
  // that actually shipped. We re-query because writeLeads pruned and
  // trimmed — only the survivors should burn LLM budget. The reasoner
  // overwrites lead.agentReasoning, which the drawer surfaces.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finalLeads = await LeadModel.find(
      { jobId: new mongoose.Types.ObjectId(jobId), isDuplicate: { $ne: true } },
      { _id: 1, companyName: 1, companyDomain: 1, fitReason: 1, signals: 1, emails: 1, phones: 1, contactSummary: 1, address: 1 },
    ).lean() as Array<{
      _id: mongoose.Types.ObjectId;
      companyName?: string;
      companyDomain?: string;
      fitReason?: string;
      signals?: string[];
      emails?: Array<{ address: string }>;
      phones?: unknown[];
      contactSummary?: { totalContacts?: number; topContact?: { fullName?: string; title?: string } };
      address?: { city?: string; state?: string; country?: string };
    }>;
    if (finalLeads.length > 0) {
      await generateLeadReasons(rawQuery ?? '', parsedIntent, finalLeads, LeadModel);
    }
  } catch (err) {
    logger.warn('[hybridDiscovery] leadReasoner failed (non-fatal)', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const total_ms = Date.now() - t0;

  // ── Single aggregated [thoughts] entry per job ────────────────────────────
  // Replaces the per-event suggestion logs that used to fire from
  // validateCandidates, the subagent-timeout branch, and the prune step.
  // One entry per job is greppable, easy to scan, and actually counts the
  // pattern instead of emitting the same suggestion 3-15 times per run.
  // Suggestions only appear when their corresponding count > 0, so the
  // entry stays tight when nothing notable happened.
  const observations = {
    discovery: {
      proposed: rawCandidates.length,
      validated: valid.length + householdDropped.length,
      dns_fail: stats.dns_fail,
      http_unreachable_dropped: stats.low_confidence_fail,
      domain_invalid: stats.domain_invalid,
      household_filtered: householdDropped.length,
    },
    enrichment: {
      dispatched: dispatchedJobs.length,
      finished,
      timed_out: stuckOrFailed,
    },
    delivery: {
      requested: targetCount,
      pre_write: ranked.length,
      pruned: writeSummary.prunedCount,
      trimmed: writeSummary.trimmedCount,
      final: writeSummary.finalLeadCount,
    },
  };
  const yieldGap = Math.max(0, targetCount - writeSummary.finalLeadCount);

  const actions: string[] = [];
  if (stats.dns_fail > 0) {
    actions.push(`${stats.dns_fail} candidate(s) dropped on DNS — typically LLM hallucinations. A company-data API (Apollo, Clearbit, OpenCorporates) would resolve company → real domain instead of trusting the LLM's guess.`);
  }
  if (stuckOrFailed > 0) {
    actions.push(`${stuckOrFailed} subagent(s) timed out — bottleneck is sequential Playwright + LLM rate-limits. A paid LLM tier or cached scrape results would lift the ceiling.`);
  }
  if (writeSummary.prunedCount > 0) {
    actions.push(`${writeSummary.prunedCount} lead(s) pruned for no reachable contact. Hunter.io or Apollo.io would recover most of these by domain alone.`);
  }
  if (yieldGap > 0 && actions.length === 0) {
    actions.push(`Delivered ${writeSummary.finalLeadCount} of ${targetCount} requested. Discovery sources returned ${rawCandidates.length} candidates — augment with Hunter, Apollo, or LinkedIn People Search to lift contact-recovery rate.`);
  }

  if (actions.length > 0 || yieldGap > 0) {
    logger.info('[thoughts] job summary', {
      jobId,
      observations,
      yield_gap: yieldGap,
      top_actions: actions,
    });
  }

  logger.info('[hybridDiscovery] complete', {
    jobId,
    discovery_ms,
    validation_ms,
    enrichment_ms,
    total_ms,
    candidates_proposed: rawCandidates.length,
    candidates_validated: valid.length,
    candidates_dropped: dropped.length,
    leads_written: ranked.length,
    pruned: writeSummary.prunedCount,
    trimmed: writeSummary.trimmedCount,
    final_count: writeSummary.finalLeadCount,
    timed_out: timedOut,
  });

  return {
    leads: [],
    stepsUsed: 1, // one LLM call for discovery
    stopReason: timedOut ? 'wall_clock' : 'agent_done',
    transcript: [`Hybrid discovery: ${rawCandidates.length} proposed → ${valid.length} validated → ${ranked.length} leads`],
    fanOutComplete: true,
    leadsFound: ranked.length,
  };
}
