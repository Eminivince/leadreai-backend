import { logger } from '../utils/logger.js';
import { callLlmOnce, isLlmConfigured } from '../utils/llmClient.js';
import { runSerpSearch } from './serpScraper.js';
import type { ParsedIntent } from '../../shared/index.js';

const ENTITY_EXTRACT_PROMPT = `You are an expert at identifying company or organization names from web search results.

Given a search query and a list of result snippets, extract the specific company or organization names that directly answer the query.

Rules:
- Return ONLY a JSON array of strings: ["Company A", "Company B", ...]
- Include only actual company/organization names (not generic terms, adjectives, or descriptions)
- Prefer official/registered names over common abbreviations
- Include at most 20 names (the top ones by apparent prominence)
- If no specific companies can be identified, return []
- Output ONLY the JSON array, no markdown, no explanation`;

async function extractEntityNamesWithAI(
  searchQuery: string,
  snippets: string[],
  targetCount: number,
): Promise<string[]> {
  if (!isLlmConfigured() || snippets.length === 0) {
    logger.warn('[entityResolver] No LLM or snippets — skipping AI extraction');
    return [];
  }

  // Ask for 2× headroom; downstream (queryBuilder) uses slice(0, 10) so extra names are fine
  const askFor = Math.min(targetCount * 2, 20);
  const userMessage = `Search query: "${searchQuery}"\n\nSearch result snippets:\n${snippets.slice(0, 15).map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nExtract the top ${askFor} company/organization names from these results.`;

  const result = await callLlmOnce({
    messages: [
      { role: 'system', content: ENTITY_EXTRACT_PROMPT },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 512,
    timeoutMs: 15_000,
  }).catch((err) => {
    logger.warn('[entityResolver] LLM fetch failed', { err: err instanceof Error ? err.message : String(err) });
    return null;
  });

  if (!result || !result.ok || !result.content) {
    logger.warn('[entityResolver] LLM returned empty/non-OK', { status: result?.status });
    return [];
  }
  const content = result.content;

  const match = content.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, askFor);
  } catch {
    return [];
  }
}

/**
 * For named_entity_list queries with namedEntities === null:
 * Run a SerpAPI search to discover the specific companies matching the query,
 * then use AI to extract their names from the snippets.
 *
 * Returns a list of resolved company names (may be empty if lookup fails — pipeline continues gracefully).
 */
export async function resolveNamedEntities(intent: ParsedIntent): Promise<string[]> {
  if (intent.queryType !== 'named_entity_list') return [];
  // If names were already specified in the query, use them directly
  if (intent.namedEntities && intent.namedEntities.length > 0) {
    logger.info('[entityResolver] Named entities already provided — skipping resolution', {
      count: intent.namedEntities.length,
    });
    return intent.namedEntities as string[];
  }

  const { industry, geography, targetCount } = intent;
  const locationParts = [geography.city, geography.state, geography.country].filter(Boolean);
  const location = locationParts.length > 0 ? locationParts.join(', ') : 'worldwide';
  const searchQuery = `top ${targetCount} ${industry} in ${location}`;

  logger.info('[entityResolver] Resolving named entities via SerpAPI', { searchQuery });

  const results = await runSerpSearch([searchQuery]).catch((err) => {
    logger.warn('[entityResolver] SerpAPI failed during entity resolution', { err });
    return [];
  });

  if (results.length === 0) {
    logger.warn('[entityResolver] No SerpAPI results for entity resolution');
    return [];
  }

  const snippets = results.map(r => `${r.title}: ${r.snippet}`);
  const names = await extractEntityNamesWithAI(searchQuery, snippets, targetCount);

  logger.info('[entityResolver] Resolved entity names', { count: names.length, names });
  return names;
}
