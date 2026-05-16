# Discovery Pipeline Modes

Controlled by the `DISCOVERY_MODE` environment variable.

## `old` — Dispatcher agent + parallel subagents

The original pipeline. A full LLM agent loop (up to 40 steps, 60 s) uses search and registry tools to build a candidate list. Each candidate is then handed to a parallel subagent (up to 20 steps, 90 s each) for deep enrichment.

**When to use:** When data quality is the top priority and cost/speed are secondary. The agent can recover from bad search results by retrying with different queries.

**Typical cost:** ~50 LLM calls for discovery + ~15 × 15 calls for enrichment = ~275 total.
**Typical wall-clock:** 3–8 minutes.

## `smart` — Parallel SERP + regex parse + one LLM contact call

Fast 5-step pipeline. Runs 4–5 SERP queries in parallel, extracts company names from search result titles using a regex separator pattern, makes one small LLM call for known executive names, then verifies emails via MX + SMTP in parallel.

**When to use:** High-volume queries where speed matters more than depth. Works best when target companies have strong search presence.

**Known limitation:** Returns search result page domains as companies when Google surfaces articles instead of company homepages (e.g. "Top 21 travel agencies in Nigeria" → returns the article site, not the agencies).

**Typical cost:** 1 LLM call.
**Typical wall-clock:** 10–25 seconds.

## `hybrid` — Single LLM discovery + validation + existing subagents (default)

Replaces the dispatcher loop with a single Anthropic API call. The model draws on training knowledge to propose candidates with structured fit-reasons. Candidates are validated via DNS + HTTP before enrichment. Survivors are handed to the existing subagent enrichment logic.

**When to use:** Default. Better quality than Smart Discovery (model reasoning, not SERP parsing). Faster and cheaper than Old (1 discovery call vs 40-step loop). Requires `ANTHROPIC_API_KEY`.

**Typical cost:** 1 Anthropic call + ~15 × 15 subagent enrichment calls.
**Typical wall-clock:** 30–90 seconds (discovery + validation ~5 s, enrichment parallel ~60–90 s).

---

## Switching modes

```bash
# .env
DISCOVERY_MODE=old      # revert to original dispatcher loop
DISCOVERY_MODE=smart    # fast SERP-based pipeline
DISCOVERY_MODE=hybrid   # new default — single LLM call + subagents
```

## Hybrid-specific fields on leads

Leads produced by the hybrid pipeline have two extra fields:

- `fitReason` — 2-3 sentences explaining why this company matches the user's query. References concrete company attributes, not generic praise. Surfaces in the lead detail drawer.
- `signals` — 1-3 short tags (e.g. "Series A", "50-200 staff", "Nigeria HQ"). Also merged into `tags`.

## Monitoring hallucination rates

Every hybrid job logs a `[hybridDiscovery] complete` entry with:

```json
{
  "candidates_proposed": 18,
  "candidates_validated": 14,
  "candidates_dropped": 4,
  "drop_reasons": {
    "domain_invalid": 1,
    "dns_fail": 2,
    "low_confidence_fail": 1
  }
}
```

A high `dns_fail` rate means the model is hallucinating domains. Switch to a higher-quality model via `ANTHROPIC_DISCOVERY_MODEL` or tighten the prompt.
