import { enrichEntity } from '../registries/opencorporates.js';
import type { ToolDef } from './index.js';

export const lookupRegistryTool: ToolDef = {
  name: 'lookup_registry',
  description: 'Look up a company in the OpenCorporates global business registry. Returns registered name, address, and officer names. Excellent source of director names when you need emails via permute_email.',
  parametersSchema: '{"name": string, "country"?: string}',
  handler: async (args) => {
    const name = String(args?.name ?? '').trim();
    if (!name) return { ok: false, output: 'name required' };
    const country = args?.country ? String(args.country) : undefined;
    const result = await enrichEntity(name, country);
    if (!result) return { ok: true, output: JSON.stringify({ found: false }) };
    return {
      ok: true,
      output: JSON.stringify({
        found: true,
        name: result.name,
        companyNumber: result.companyNumber,
        jurisdictionCode: result.jurisdictionCode,
        registeredAddress: result.registeredAddress,
        officers: result.officers.slice(0, 10),
      }),
    };
  },
};
