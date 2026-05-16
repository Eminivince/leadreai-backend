import { scoreLeadRelevance } from '../leadScorer.js';
import type { ToolDef } from './index.js';
import type { LeadRecord } from '../deduplicator.js';

export const scoreLeadTool: ToolDef = {
  name: 'score_lead',
  description: 'Score a lead candidate against the user query. Returns {score 0-1, reason}. Optional — use to rank or explain relevance, but do NOT use as a gate to block write_lead. Always write the lead even if score is low.',
  parametersSchema: '{"companyName": string, "companyDomain": string, "emails": [{address,type,confidence}], "phones": [{raw}], "topContactName"?: string, "topContactTitle"?: string}',
  handler: async (args, ctx) => {
    const stub: LeadRecord = {
      workspaceId: ctx.workspaceId,
      jobId: ctx.jobId,
      companyName: String(args?.companyName ?? ''),
      companyDomain: String(args?.companyDomain ?? ''),
      industry: ctx.parsedIntent.industry ?? undefined,
      address: {
        country: ctx.parsedIntent.geography?.country ?? undefined,
        city: ctx.parsedIntent.geography?.city ?? undefined,
        state: ctx.parsedIntent.geography?.state ?? undefined,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emails: (args?.emails ?? []) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      phones: (args?.phones ?? []) as any,
      socialProfiles: undefined,
      osint: {} as Record<string, unknown>,
      sources: [],
      rawSnippets: [],
      rankScore: 0,
      completenessScore: 0,
      isDuplicate: false,
      tags: [],
    };
    const result = await scoreLeadRelevance(stub, ctx.parsedIntent);
    return {
      ok: true,
      output: JSON.stringify(result),
      meta: { score: result.score, isVerified: result.isVerified },
    };
  },
};
