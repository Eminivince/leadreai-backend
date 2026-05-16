/**
 * One-off debug script: reproduces AI_SCHEMA_ERROR from /jobs endpoint by
 * invoking parseQuery directly. Run with: pnpm tsx --env-file=../.env scripts/repro-queryparser.ts
 */
import { parseQuery } from '../src/services/ai/queryParser.js';

const QUERIES = ['get me the phone number and email of anyone at FUR ALLE LIMITED'];
const RUNS_PER_QUERY = 10;

async function main() {
  let failures = 0;
  for (const q of QUERIES) {
    for (let i = 0; i < RUNS_PER_QUERY; i++) {
      process.stdout.write(`[${q.slice(0, 40)}...] run ${i + 1}: `);
      try {
        const parsed = await parseQuery(q);
        console.log(`ok  (queryType=${parsed.queryType}, industry=${JSON.stringify(parsed.industry)}, targetCount=${parsed.targetCount})`);
      } catch (err) {
        failures++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`FAIL — ${msg}`);
      }
    }
  }
  console.log(`\n[repro] total failures: ${failures}/${QUERIES.length * RUNS_PER_QUERY}`);
}

main().catch((e) => {
  console.error('[repro] unhandled error:', e);
  process.exit(1);
});
