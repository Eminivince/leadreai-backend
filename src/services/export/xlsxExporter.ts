import ExcelJS from 'exceljs';
import type { ILead } from '../../models/Lead.js';
import type { ExportBranding } from './csvExporter.js';

/**
 * XLSX exporter with full evidence preservation.
 *
 * Sheet 1 ("Cover") — white-label cover page (Task #12). Carries the
 *   producing agency's displayName + contact + report title + the
 *   client this report was prepared for (when set). Omitted entirely
 *   when no branding is passed so the legacy default look is preserved.
 * Sheet 2 ("Leads") — the flat lead row a Sales person actually opens.
 * Sheet 3 ("Evidence") — one row per source per lead, so an auditor can
 *   follow "this email came from THIS scrape on THIS date" without
 *   parsing any JSON. This is the agency / regulated-buyer requirement
 *   from goal.md §11.
 * Sheet 4 ("Facts") — per-cell provenance (sourceUrl + confidence per
 *   fact) for workspaces that use Phase 15D column enrichment.
 */
export async function leadsToXlsx(leads: ILead[], branding?: ExportBranding): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  if (branding) {
    const cover = workbook.addWorksheet('Cover');
    cover.columns = [{ width: 22 }, { width: 60 }];
    cover.addRow([]);
    const titleRow = cover.addRow(['', branding.reportTitle ?? 'Lead research export']);
    titleRow.font = { bold: true, size: 22, color: { argb: 'FF1F2937' } };
    cover.addRow([]);
    if (branding.displayName) cover.addRow(['Produced by', branding.displayName]);
    if (branding.clientLabel) cover.addRow(['Prepared for', branding.clientLabel]);
    if (branding.contactEmail) cover.addRow(['Contact', branding.contactEmail]);
    cover.addRow(['Generated', new Date().toISOString()]);
    cover.addRow(['Lead count', leads.length]);
    // Highlight the "label" column so it reads like a key-value sheet.
    cover.getColumn(1).font = { bold: true, color: { argb: 'FF4B5563' } };
  }

  const sheet = workbook.addWorksheet('Leads');

  sheet.columns = [
    { header: 'Company Name', key: 'companyName', width: 30 },
    { header: 'Domain', key: 'domain', width: 25 },
    { header: 'Industry', key: 'industry', width: 20 },
    { header: 'Country', key: 'country', width: 15 },
    { header: 'City', key: 'city', width: 15 },
    { header: 'Website', key: 'website', width: 30 },
    { header: 'Primary Email', key: 'primaryEmail', width: 30 },
    { header: 'Email Confidence', key: 'emailConfidence', width: 15 },
    { header: 'All Emails', key: 'allEmails', width: 40 },
    { header: 'Primary Phone', key: 'primaryPhone', width: 20 },
    { header: 'All Phones', key: 'allPhones', width: 30 },
    { header: 'LinkedIn', key: 'linkedin', width: 35 },
    { header: 'Rank Score', key: 'rankScore', width: 12 },
    { header: 'Outreach Status', key: 'outreachStatus', width: 18 },
    { header: 'Tags', key: 'tags', width: 20 },
    { header: 'Description', key: 'description', width: 40 },
    { header: 'Agent Reasoning', key: 'agentReasoning', width: 40 },
    { header: 'Source URLs (top 3)', key: 'sourceUrls', width: 60 },
    { header: 'Evidence count', key: 'evidenceCount', width: 15 },
  ];

  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };

  for (const lead of leads) {
    sheet.addRow({
      companyName: lead.companyName,
      domain: lead.companyDomain ?? '',
      industry: lead.industry ?? '',
      country: lead.address?.country ?? '',
      city: lead.address?.city ?? '',
      website: lead.website ?? '',
      primaryEmail: lead.emails[0]?.address ?? '',
      emailConfidence: lead.emails[0]?.confidence ?? '',
      allEmails: lead.emails.map(e => e.address).join('; '),
      primaryPhone: lead.phones[0]?.normalized ?? lead.phones[0]?.raw ?? '',
      allPhones: lead.phones.map(p => p.normalized ?? p.raw).join('; '),
      linkedin: lead.socialProfiles?.linkedinUrl ?? '',
      rankScore: lead.rankScore,
      outreachStatus: lead.outreachStatus,
      tags: lead.tags.join(', '),
      description: lead.description ?? '',
      agentReasoning: lead.agentReasoning ?? '',
      sourceUrls: (lead.sources ?? []).slice(0, 3).map(s => s.url).join(' | '),
      evidenceCount: (lead.sources ?? []).length,
    });
  }

  // Evidence sheet — one row per source per lead. The "Click once and
  // answer where this lead came from" surface for client audits.
  const evidence = workbook.addWorksheet('Evidence');
  evidence.columns = [
    { header: 'Lead Company', key: 'company', width: 30 },
    { header: 'Lead Domain', key: 'domain', width: 25 },
    { header: 'Source URL', key: 'url', width: 60 },
    { header: 'Source Type', key: 'type', width: 18 },
    { header: 'Confidence', key: 'confidence', width: 12 },
    { header: 'Scraped At (UTC)', key: 'scrapedAt', width: 22 },
  ];
  evidence.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  evidence.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };

  for (const lead of leads) {
    for (const src of lead.sources ?? []) {
      evidence.addRow({
        company: lead.companyName,
        domain: lead.companyDomain ?? '',
        url: src.url,
        type: src.type ?? '',
        confidence: src.confidence ?? '',
        scrapedAt: src.scrapedAt ? src.scrapedAt.toISOString() : '',
      });
    }
  }

  // Facts sheet — populated only when leads carry the new `facts` map
  // (added by Phase 15D column-referenced enrichment). Adds per-field
  // provenance so a regulated buyer can verify each cell, not just each
  // lead.
  const facts = workbook.addWorksheet('Facts');
  facts.columns = [
    { header: 'Lead Company', key: 'company', width: 30 },
    { header: 'Lead Domain', key: 'domain', width: 25 },
    { header: 'Field', key: 'field', width: 24 },
    { header: 'Value', key: 'value', width: 40 },
    { header: 'Source URL', key: 'sourceUrl', width: 60 },
    { header: 'Confidence', key: 'confidence', width: 12 },
  ];
  facts.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  facts.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  for (const lead of leads) {
    if (!lead.facts) continue;
    for (const [field, v] of Object.entries(lead.facts as Record<string, { value: unknown; sourceUrl?: string; confidence?: number }>)) {
      facts.addRow({
        company: lead.companyName,
        domain: lead.companyDomain ?? '',
        field,
        value: typeof v.value === 'string' ? v.value : JSON.stringify(v.value),
        sourceUrl: v.sourceUrl ?? '',
        confidence: v.confidence ?? '',
      });
    }
  }

  return workbook.xlsx.writeBuffer().then(buf => Buffer.from(buf));
}
