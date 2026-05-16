import { stringify } from 'csv-stringify';
import type { ILead } from '../../models/Lead.js';

/** White-label branding block (Task #12). Optional — when absent the
 *  exporter behaves identically to its pre-branding form. */
export interface ExportBranding {
  displayName?: string;
  logoUrl?: string;
  contactEmail?: string;
  reportTitle?: string;
  clientLabel?: string;
}

/**
 * Serialise a lead's sources[] into a JSON string. Truncated to avoid
 * blowing the Excel-imported CSV cell limit (32k chars) — we cap the
 * embedded JSON at 24k chars and append `...truncated` if it exceeds.
 * For the full graph use `format=proof-bundle`.
 */
function evidenceJson(lead: ILead): string {
  const sources = (lead.sources ?? []).map((s) => ({
    url: s.url,
    type: s.type,
    confidence: s.confidence,
    scrapedAt: s.scrapedAt?.toISOString?.() ?? null,
  }));
  const facts = lead.facts
    ? Object.fromEntries(
        Object.entries(lead.facts as Record<string, { value: unknown; sourceUrl?: string; confidence?: number; scrapedAt?: Date }>).map(
          ([k, v]) => [k, { value: v.value, sourceUrl: v.sourceUrl, confidence: v.confidence }],
        ),
      )
    : undefined;
  const json = JSON.stringify({ sources, facts });
  if (json.length > 24_000) return json.slice(0, 24_000) + '"…truncated"]}';
  return json;
}

export function leadsToCsv(leads: ILead[], branding?: ExportBranding): Promise<string> {
  // CSV header comments (lines prefixed with `#`) carry branding without
  // affecting the column header row — most spreadsheet apps ignore lines
  // starting with `#` if the parser is told to, and at minimum the user
  // sees the agency identity when they open the file in a text editor.
  // Excel will interpret these as data rows but they sort to the top.
  const headerComments: string[] = [];
  if (branding?.displayName) headerComments.push(`# Produced by: ${branding.displayName}`);
  if (branding?.clientLabel) headerComments.push(`# For client: ${branding.clientLabel}`);
  if (branding?.contactEmail) headerComments.push(`# Contact: ${branding.contactEmail}`);
  if (branding?.reportTitle) headerComments.push(`# Report: ${branding.reportTitle}`);
  headerComments.push(`# Generated: ${new Date().toISOString()}`);

  return new Promise((resolve, reject) => {
    const rows = leads.map(lead => ({
      'Company Name': lead.companyName,
      'Domain': lead.companyDomain ?? '',
      'Industry': lead.industry ?? '',
      'Country': lead.address?.country ?? '',
      'City': lead.address?.city ?? '',
      'Website': lead.website ?? '',
      'Primary Email': lead.emails[0]?.address ?? '',
      'Email Confidence': lead.emails[0]?.confidence ?? '',
      'All Emails': lead.emails.map(e => e.address).join('; '),
      'Primary Phone': lead.phones[0]?.normalized ?? lead.phones[0]?.raw ?? '',
      'All Phones': lead.phones.map(p => p.normalized ?? p.raw).join('; '),
      'LinkedIn': lead.socialProfiles?.linkedinUrl ?? '',
      'Rank Score': lead.rankScore,
      'Outreach Status': lead.outreachStatus,
      'Tags': lead.tags.join(', '),
      'Description': lead.description ?? '',
      'Agent Reasoning': lead.agentReasoning ?? '',
      'Source URLs': (lead.sources ?? []).slice(0, 3).map(s => s.url).join(' | '),
      'Evidence count': (lead.sources ?? []).length,
      // Full evidence graph as JSON — agencies use this to back claims
      // when client asks "where did this lead come from?". XLSX export
      // gets a dedicated Evidence sheet; CSV is one column.
      'Evidence (JSON)': evidenceJson(lead),
    }));

    stringify(rows, { header: true }, (err, output) => {
      if (err) reject(err);
      else resolve(headerComments.length > 0 ? `${headerComments.join('\n')}\n${output}` : output);
    });
  });
}
