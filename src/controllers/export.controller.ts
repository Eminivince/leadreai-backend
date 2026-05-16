import type { Request, Response } from 'express';
import Lead from '../models/Lead.js';
import Workspace from '../models/Workspace.js';
import { ApiError } from '../utils/ApiError.js';
import { leadsToCsv } from '../services/export/csvExporter.js';
import { leadsToXlsx } from '../services/export/xlsxExporter.js';

export async function exportLeads(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  const { format = 'csv', jobId } = req.query as { format?: string; jobId?: string };

  const ALLOWED = ['csv', 'xlsx', 'json', 'proof-bundle'];
  if (!ALLOWED.includes(format)) {
    throw ApiError.badRequest(`format must be one of: ${ALLOWED.join(', ')}`);
  }

  const filter: Record<string, unknown> = { workspaceId, isDuplicate: false };
  if (jobId) filter.jobId = jobId;

  const leads = await Lead.find(filter).sort({ rankScore: -1 }).limit(5000);

  // Workspace branding lookup (Task #12 — white-label exports). A client
  // sub-workspace inherits parent branding when its own block is empty.
  // We collapse both into a single flat block for downstream renderers.
  const workspace = await Workspace.findById(workspaceId)
    .select('branding parentWorkspaceId clientLabel name')
    .lean();
  let branding = workspace?.branding;
  if ((!branding || !branding.displayName) && workspace?.parentWorkspaceId) {
    const parent = await Workspace.findById(workspace.parentWorkspaceId)
      .select('branding')
      .lean();
    branding = { ...(parent?.branding ?? {}), ...(branding ?? {}) };
  }
  const brandingBlock = {
    displayName: branding?.displayName ?? workspace?.name,
    logoUrl: branding?.logoUrl,
    contactEmail: branding?.contactEmail,
    reportTitle: branding?.reportTitle ?? 'Lead research export',
    clientLabel: workspace?.clientLabel,
  };

  if (format === 'xlsx') {
    const buffer = await leadsToXlsx(leads, brandingBlock);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${workspaceId}.xlsx"`);
    res.send(buffer);
    return;
  }

  if (format === 'json') {
    res.json({ success: true, data: leads });
    return;
  }

  if (format === 'proof-bundle') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="leads-proof-bundle-${workspaceId}.json"`);
    res.send(JSON.stringify({
      generatedAt: new Date().toISOString(),
      workspaceId,
      jobId: jobId ?? null,
      producedBy: brandingBlock,
      leadCount: leads.length,
      leads,
    }, null, 2));
    return;
  }

  const csv = await leadsToCsv(leads, brandingBlock);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${workspaceId}.csv"`);
  res.send(csv);
}
