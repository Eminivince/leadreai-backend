import dns from 'node:dns/promises';
import { logger } from '../utils/logger.js';
import type { HybridCandidate } from '../pipeline/jobSubagent.js';

export type RawCandidate = HybridCandidate;

export interface DroppedCandidate {
  candidate: RawCandidate;
  reason: 'domain_invalid' | 'dns_fail' | 'http_unreachable' | 'low_confidence_fail';
}

export interface ValidationResult {
  valid: HybridCandidate[];
  dropped: DroppedCandidate[];
  stats: {
    proposed: number;
    validated: number;
    domain_invalid: number;
    dns_fail: number;
    http_unreachable: number;
    low_confidence_fail: number;
  };
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/i;
const HEAD_TIMEOUT_MS = 5_000;

/**
 * Webmail providers that occasionally get returned as a company's "domain"
 * by the LLM-recall path (typically when the model only knew the operator's
 * personal Gmail/Yahoo address). These are real, resolvable domains, so
 * neither DNS nor HTTP validation catches them — we have to call them out
 * explicitly. Treated as domain-less candidates downstream so the subagent
 * searches for a real footprint instead of trying to scrape gmail.com.
 */
const WEBMAIL_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.co.uk', 'live.com', 'outlook.com', 'msn.com',
  'aol.com', 'aim.com',
  'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me',
  'gmx.com', 'gmx.net', 'mail.com',
  'zoho.com',
  'yandex.com', 'yandex.ru',
]);

function isValidDomainShape(domain: string): boolean {
  return DOMAIN_RE.test(domain) && !domain.startsWith('-') && !domain.endsWith('-');
}

async function checkDns(domain: string): Promise<boolean> {
  try {
    await dns.resolve(domain);
    return true;
  } catch {
    return false;
  }
}

async function checkHttp(domain: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${domain}`, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    // Accept any 2xx or 3xx. Many sites return 405 on HEAD but are clearly reachable —
    // treat that as reachable too.
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Validates a list of raw LLM-proposed candidates.
 *
 * Drop logic:
 * - Invalid domain shape → always drop.
 * - DNS failure → always drop (can't enrich a non-existent domain).
 * - HTTP unreachable → drop only if confidence is 'low' (medium/high survive
 *   because many real corporate sites block HEAD or require auth).
 *
 * All checks run in parallel via Promise.allSettled.
 */
export async function validateCandidates(candidates: RawCandidate[]): Promise<ValidationResult> {
  const stats = {
    proposed: candidates.length,
    validated: 0,
    domain_invalid: 0,
    dns_fail: 0,
    http_unreachable: 0,
    low_confidence_fail: 0,
  };

  const valid: HybridCandidate[] = [];
  const dropped: DroppedCandidate[] = [];

  const results = await Promise.allSettled(
    candidates.map(async (c) => {
      // Domainless candidate (typically directory-sourced — name + snippet
      // only). Skip DNS/HTTP validation; the subagent will discover the
      // footprint via search. Already marked domainUnverified=true upstream.
      if (!c.domain || c.domain.trim() === '') {
        return { candidate: c, drop: null };
      }

      // Webmail provider proposed as a company's domain — neither
      // hallucination (it resolves) nor a usable company identity (gmail.com
      // can't be a company). Drop the bad domain assignment but keep the
      // candidate domain-less so the subagent can search for a real
      // footprint via the company name.
      if (WEBMAIL_PROVIDERS.has(c.domain.toLowerCase())) {
        return { candidate: { ...c, domain: '', domainUnverified: true }, drop: null };
      }

      // 1. Domain shape
      if (!isValidDomainShape(c.domain)) {
        return { candidate: c, drop: 'domain_invalid' as const };
      }

      // 2. DNS + HTTP in parallel
      const [dnsOk, httpOk] = await Promise.all([checkDns(c.domain), checkHttp(c.domain)]);

      // DNS fail with a proposed domain is a hallucination signal. When
      // the discovery LLM is asked for niche Nigerian businesses it
      // doesn't really know, it generates plausibly-named placeholder
      // companies with plausibly-named placeholder domains that never
      // resolve. Drop them — a real company will be re-discovered via
      // SERP for the company name on the next pass.
      //
      // !httpOk with medium/high confidence: keep. Many real Nigerian
      // sites geo-block cloud-datacenter IPs from where this worker
      // runs, so unreachability isn't a strong death signal for
      // confident candidates. Per-event logs were removed; the
      // aggregated job-end [thoughts] summary in hybridDiscovery
      // captures the count and the residential-proxy suggestion.
      if (!dnsOk) return { candidate: c, drop: 'dns_fail' as const };
      if (!httpOk && c.confidence === 'low') return { candidate: c, drop: 'low_confidence_fail' as const };
      return { candidate: c, drop: null };
    }),
  );

  for (const r of results) {
    if (r.status === 'rejected') {
      // Unexpected error in the check itself — treat as dropped
      logger.warn('[validateCandidates] check threw unexpectedly', { err: String(r.reason) });
      continue;
    }
    const { candidate, drop } = r.value;
    if (drop) {
      dropped.push({ candidate, reason: drop });
      stats[drop]++;
    } else {
      valid.push(candidate);
      stats.validated++;
    }
  }

  logger.info('[validateCandidates] complete', {
    proposed: stats.proposed,
    validated: stats.validated,
    dropped: dropped.length,
    drop_reasons: {
      domain_invalid: stats.domain_invalid,
      dns_fail: stats.dns_fail,
      http_unreachable: stats.http_unreachable,
      low_confidence_fail: stats.low_confidence_fail,
    },
  });

  return { valid, dropped, stats };
}
