import type { ToolDef } from './index.js';

/**
 * queue_company — dispatcher-only tool.
 *
 * Adds a discovered company to the dispatcher's candidate list. Deduplicates
 * on companyDomain when provided. The dispatcher calls this instead of
 * write_lead — enrichment happens in a separate per-company subagent.
 */
export const queueCompanyTool: ToolDef = {
  name: 'queue_company',
  description:
    'Register a discovered company for enrichment by a parallel subagent. Call once per candidate domain. Do NOT call write_lead — that is the subagent\'s job.',
  parametersSchema: '{"companyName": string, "companyDomain"?: string, "hints"?: string[]}',
  handler: async (args, ctx) => {
    if (!ctx.candidatesSoFar) {
      return { ok: false, output: 'queue_company is not available outside dispatcher mode.' };
    }
    const name = String(args?.companyName ?? '').trim();
    const domain = args?.companyDomain ? String(args.companyDomain).trim().toLowerCase() : undefined;
    if (!name) return { ok: false, output: 'companyName is required.' };

    const normalizedName = name.toLowerCase();
    const alreadyQueued = ctx.candidatesSoFar.some(c => {
      if (domain && c.companyDomain) return c.companyDomain === domain;
      return c.companyName.toLowerCase() === normalizedName;
    });
    if (alreadyQueued) {
      return { ok: true, output: `${name}${domain ? ` (${domain})` : ''} already queued. Total: ${ctx.candidatesSoFar.length}` };
    }

    const hints: string[] = Array.isArray(args?.hints)
      ? (args.hints as unknown[]).map(String).slice(0, 5) // cap to keep subagent prompt context small
      : [];

    ctx.candidatesSoFar.push({ companyName: name, companyDomain: domain, hints });
    return {
      ok: true,
      output: `Queued ${name}${domain ? ` (${domain})` : ''}. Total candidates: ${ctx.candidatesSoFar.length}`,
    };
  },
};
