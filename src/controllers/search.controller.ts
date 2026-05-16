import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import ProspectingJob from '../models/ProspectingJob.js';
import File from '../models/File.js';
import Campaign from '../models/Campaign.js';
import { ApiError } from '../utils/ApiError.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GROUP_LIMIT = 5;

/**
 * Global search across the four main entities a user asks about:
 * leads, dispatches (jobs), files, and campaigns. Queries run in
 * parallel; each returns up to GROUP_LIMIT hits. The client groups
 * and renders them as palette rows.
 *
 * Matching: case-insensitive regex on the most-asked-for label per
 * entity. Deliberately not using $text — mixing text and regex across
 * collections would need index guarantees per collection, and for a
 * palette the expected inputs are short prefixes, not full-text queries.
 */
export async function globalSearch(req: Request, res: Response): Promise<void> {
  const { workspaceId } = req.params;
  if (!req.user) throw ApiError.unauthorized();

  const raw = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  if (!raw) {
    res.json({
      success: true,
      data: { q: '', leads: [], jobs: [], files: [], campaigns: [] },
    });
    return;
  }

  const safe = escapeRegex(raw);
  const re = new RegExp(safe, 'i');
  const wsOid = new mongoose.Types.ObjectId(workspaceId!);

  const [leads, jobs, files, campaigns] = await Promise.all([
    Lead.find(
      {
        workspaceId: wsOid,
        isDuplicate: { $ne: true },
        $or: [
          { companyName: re },
          { companyDomain: re },
          { 'contactSummary.topContact.fullName': re },
          { industry: re },
        ],
      },
      { companyName: 1, companyDomain: 1, industry: 1, contactSummary: 1 },
    )
      .limit(GROUP_LIMIT)
      .lean(),

    ProspectingJob.find(
      { workspaceId: wsOid, rawQuery: re },
      { rawQuery: 1, status: 1, createdAt: 1, 'progress.leadsFoundSoFar': 1 },
    )
      .sort({ createdAt: -1 })
      .limit(GROUP_LIMIT)
      .lean(),

    File.find(
      {
        workspaceId: wsOid,
        archivedAt: { $exists: false },
        $or: [{ name: re }, { description: re }],
      },
      { name: 1, description: 1, source: 1, leadIds: 1, updatedAt: 1 },
    )
      .sort({ updatedAt: -1 })
      .limit(GROUP_LIMIT)
      .lean(),

    Campaign.find(
      {
        workspaceId: wsOid,
        $or: [{ name: re }, { description: re }],
      },
      { name: 1, description: 1, status: 1, updatedAt: 1 },
    )
      .sort({ updatedAt: -1 })
      .limit(GROUP_LIMIT)
      .lean(),
  ]);

  res.json({
    success: true,
    data: {
      q: raw,
      leads: leads.map((l) => ({
        _id: String(l._id),
        companyName: l.companyName,
        companyDomain: l.companyDomain,
        industry: l.industry,
        contactName: l.contactSummary?.topContact?.fullName,
      })),
      jobs: jobs.map((j) => ({
        _id: String(j._id),
        rawQuery: j.rawQuery,
        status: j.status,
        leadsFoundSoFar: j.progress?.leadsFoundSoFar ?? 0,
        createdAt: j.createdAt?.toISOString?.() ?? String(j.createdAt),
      })),
      files: files.map((f) => ({
        _id: String(f._id),
        name: f.name,
        description: f.description,
        source: f.source,
        leadCount: Array.isArray(f.leadIds) ? f.leadIds.length : 0,
      })),
      campaigns: campaigns.map((c) => ({
        _id: String(c._id),
        name: c.name,
        description: c.description,
        status: c.status,
      })),
    },
  });
}
