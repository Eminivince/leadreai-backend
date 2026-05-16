import type { ToolDef } from './index.js';
import { runWorkerDataSource } from '../../services/data-sources/executor.js';

/**
 * search_workspace_leads — agent tool wrapper.
 *
 * Thin shim over the `search_workspace_leads` DataSource. Two reasons
 * to keep the wrapper separate from the DataSource itself:
 *   1. Tool handlers expose `parametersSchema` as a human-readable
 *      string for the LLM, distinct from the Zod schema used by the
 *      executor for structural validation.
 *   2. Going through the executor means every call writes a
 *      DataSourceInvocation row — unified audit log regardless of
 *      whether a source was called from the agent, a manual API
 *      invocation, or future table enrichment.
 *
 * In 15A's "hybrid integration" terms: this is the first worked
 * example of a DataSource surfaced AS an agent tool. The rest of the
 * 14 tools migrate the same way, one-by-one.
 */

export const searchWorkspaceLeadsTool: ToolDef = {
  name: 'search_workspace_leads',
  description:
    "Search leads this workspace has ALREADY researched. CALL THIS FIRST for any demographic query — reusing prior research is free and way cheaper than SERP or scraping. Filter by industry / country / city / keywords. Returns up to 20 matches with rank, contact flags, and top named contact when available.",
  parametersSchema:
    '{"industry"?: string, "country"?: string, "city"?: string, "keywords"?: string, "verifiedOnly"?: boolean, "minRankScore"?: number, "maxResults"?: number (1-50, default 20)}',
  handler: async (args, ctx) => {
    const input = {
      industry: typeof args?.industry === 'string' ? args.industry : undefined,
      country: typeof args?.country === 'string' ? args.country : undefined,
      city: typeof args?.city === 'string' ? args.city : undefined,
      keywords: typeof args?.keywords === 'string' ? args.keywords : undefined,
      verifiedOnly: typeof args?.verifiedOnly === 'boolean' ? args.verifiedOnly : false,
      minRankScore: typeof args?.minRankScore === 'number' ? args.minRankScore : 0,
      maxResults: typeof args?.maxResults === 'number' ? args.maxResults : 20,
    };

    const result = await runWorkerDataSource('search_workspace_leads', input, {
      workspaceId: ctx.workspaceId,
      jobId: ctx.jobId,
      triggeredBy: 'agent',
    });

    if (result.status !== 'success') {
      return {
        ok: false,
        output: JSON.stringify({
          error: result.status,
          message: result.errorMessage ?? 'workspace lead search failed',
        }),
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = result.output as any;
    // Compact summary for the LLM — full records would blow the context
    // budget. The agent can follow up with per-lead details via
    // write_lead(upsert) or the regular enrichment tools if it wants more.
    return {
      ok: true,
      output: JSON.stringify({
        totalMatched: out.totalMatched,
        hint:
          out.totalMatched === 0
            ? 'No prior research matched. Fall through to list_companies / search_web.'
            : `Reusing ${out.totalMatched} prior lead(s). Save SERP budget — go straight to verification or named-contact enrichment on these.`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        leads: out.leads.map((l: any) => ({
          companyName: l.companyName,
          companyDomain: l.companyDomain,
          industry: l.industry,
          country: l.country,
          city: l.city,
          rankScore: l.rankScore,
          hasEmail: l.hasEmail,
          hasVerifiedEmail: l.hasVerifiedEmail,
          hasPhone: l.hasPhone,
          topContactName: l.topContactName,
          topContactTitle: l.topContactTitle,
        })),
      }),
      meta: { invocationId: result.invocationId, totalMatched: out.totalMatched },
    };
  },
};
