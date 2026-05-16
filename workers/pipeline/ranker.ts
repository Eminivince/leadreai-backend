import type { LeadRecord } from './deduplicator.js';

export function rankLeads(leads: LeadRecord[], desiredFields: string[]): LeadRecord[] {
  return leads.map(lead => ({
    ...lead,
    rankScore: computeRankScore(lead, desiredFields),
    completenessScore: computeCompletenessScore(lead, desiredFields),
  }));
}

function computeRankScore(lead: LeadRecord, desiredFields: string[]): number {
  let score = 0;

  // Field completeness vs desired (40 pts max)
  const fieldChecks: Record<string, boolean> = {
    businessEmail: lead.emails.some(e => e.type === 'business' || e.confidence >= 0.8),
    officePhone: lead.phones.some(p => p.type === 'office'),
    mobilePhone: lead.phones.some(p => p.type === 'mobile'),
    address: !!(lead.address?.city || lead.address?.country),
    website: !!lead.website,
    linkedin: !!lead.socialProfiles?.linkedinUrl,
    whois: !!(lead.osint as Record<string, unknown> | undefined)?.whois,
    techStack: Array.isArray((lead.osint as Record<string, unknown> | undefined)?.techStack)
      && ((lead.osint as Record<string, unknown>).techStack as unknown[]).length > 0,
  };
  const matched = desiredFields.filter(f => fieldChecks[f]).length;
  score += desiredFields.length > 0 ? (matched / desiredFields.length) * 40 : 20;

  // Email quality (20 pts max)
  const bestEmail = lead.emails.sort((a, b) => b.confidence - a.confidence)[0];
  if (bestEmail) {
    score += bestEmail.confidence >= 0.9 ? 20 : bestEmail.confidence >= 0.7 ? 12 : 5;
  }

  // Phone quality (15 pts)
  if (lead.phones.some(p => p.type === 'office')) score += 15;
  else if (lead.phones.length > 0) score += 8;

  // OSINT depth (15 pts)
  const osint = lead.osint as Record<string, unknown> | undefined;
  if (osint?.whois) score += 5;
  if ((osint?.dns as Record<string, unknown> | undefined)?.mxRecords) score += 5;
  if (osint?.ssl) score += 5;

  // Source diversity (10 pts)
  const sourceTypes = new Set(lead.sources.map(s => s.type));
  score += Math.min(sourceTypes.size * 2, 10);

  return Math.min(Math.round(score), 100);
}

function computeCompletenessScore(lead: LeadRecord, _desiredFields: string[]): number {
  // Completeness is a universal 0-100 measure — count how many of the 8 possible
  // signals are present. Denominator is always 8 (the number of checks below),
  // independent of what the user asked for (that's what rankScore is for).
  const checks = [
    lead.emails.length > 0,
    lead.phones.length > 0,
    !!lead.address?.country,
    !!lead.website,
    !!lead.socialProfiles?.linkedinUrl,
    !!(lead.osint as Record<string, unknown> | undefined)?.whois,
    !!lead.companyDomain,
    lead.sources.length > 1,
  ];
  const present = checks.filter(Boolean).length;
  return Math.round((present / checks.length) * 100);
}
