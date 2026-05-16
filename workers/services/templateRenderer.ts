interface LeadData {
  // Optional because Mongoose `strict: false` documents can legitimately
  // lack a companyName — the resolver below already handles the empty
  // case by emitting 'there' as the fallback greeting.
  companyName?: string;
  companyDomain?: string;
  industry?: string;
  website?: string;
  address?: { city?: string; country?: string };
}

interface ContactData {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  title?: string;
}

const VARIABLE_RESOLVERS: Record<string, (lead: LeadData, contact?: ContactData) => string> = {
  firstName: (l, c) => c?.firstName ?? l.companyName?.split(' ')[0] ?? '',
  lastName: (l, c) => c?.lastName ?? '',
  fullName: (l, c) => c?.fullName ?? l.companyName ?? '',
  companyName: (l) => l.companyName ?? '',
  industry: (l) => l.industry ?? '',
  city: (l) => l.address?.city ?? '',
  country: (l) => l.address?.country ?? '',
  website: (l) => l.website ?? l.companyDomain ?? '',
  title: (_, c) => c?.title ?? '',
};

export function renderTemplate(template: string, lead: LeadData, contact?: ContactData): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const resolver = VARIABLE_RESOLVERS[key];
    return resolver ? resolver(lead, contact) : '';
  });
}
