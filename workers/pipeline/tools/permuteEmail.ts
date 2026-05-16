import type { ToolDef } from './index.js';

export interface EmailPermutation {
  address: string;
  pattern: string;
}

export function permuteEmail(
  domain: string,
  firstName?: string,
  lastName?: string,
): EmailPermutation[] {
  const d = domain.toLowerCase().replace(/^www\./, '');
  const generic: EmailPermutation[] = [
    { address: `info@${d}`, pattern: 'info' },
    { address: `contact@${d}`, pattern: 'contact' },
    { address: `hello@${d}`, pattern: 'hello' },
    { address: `sales@${d}`, pattern: 'sales' },
    { address: `office@${d}`, pattern: 'office' },
  ];

  if (!firstName || !lastName) return generic;

  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName.toLowerCase().replace(/[^a-z]/g, '');
  if (!f || !l) return generic;

  const named: EmailPermutation[] = [
    { address: `${f}@${d}`, pattern: 'first' },
    { address: `${f}.${l}@${d}`, pattern: 'first.last' },
    { address: `${f}${l}@${d}`, pattern: 'firstlast' },
    { address: `${f[0]}${l}@${d}`, pattern: 'flast' },
    { address: `${f[0]}.${l}@${d}`, pattern: 'f.last' },
    { address: `${f}_${l}@${d}`, pattern: 'first_last' },
    { address: `${f}-${l}@${d}`, pattern: 'first-last' },
    { address: `${l}@${d}`, pattern: 'last' },
    { address: `${l}.${f}@${d}`, pattern: 'last.first' },
    { address: `${l}${f}@${d}`, pattern: 'lastfirst' },
    { address: `${f}${l[0]}@${d}`, pattern: 'firstl' },
  ];

  return [...named, ...generic];
}

export const permuteEmailTool: ToolDef = {
  name: 'permute_email',
  description: 'Generate up to 12 common email patterns for a domain, optionally scoped to a named person. You MUST verify_email each pattern before emitting as a contact.',
  parametersSchema: '{"domain": string, "firstName"?: string, "lastName"?: string}',
  handler: async (args) => {
    const domain = String(args?.domain ?? '').trim();
    if (!domain) return { ok: false, output: 'domain required' };
    const patterns = permuteEmail(domain, args?.firstName, args?.lastName);
    return { ok: true, output: JSON.stringify(patterns) };
  },
};
