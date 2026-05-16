import type { DataSourceAction } from '../types/action.js';

/**
 * Curated catalog of enrichment actions — v1.
 *
 * Four actions, each backed by one data source. Add new actions by
 * appending here; no code elsewhere changes (the frontend modal enumerates
 * this list, the backend endpoint looks up actions by id).
 *
 * Per-action input heuristics auto-select table columns so the user
 * usually doesn't have to configure anything. When no match exists, the
 * modal surfaces the input picker for the user to choose manually.
 *
 * The `outputPath` format matches the backend's `extractAtPath` resolver
 * (enrichment.ts): dotted paths with optional [n] array indexing.
 */

export const ACTIONS: DataSourceAction[] = [
  // ── Verify emails ────────────────────────────────────────────────
  {
    id: 'verify_emails',
    label: 'Verify emails',
    description:
      'Check every email against ZeroBounce. Flags valid, catch-all, disposable, role-based, and known spamtraps.',
    category: 'verify',
    rowTypes: ['company', 'person', 'custom'],
    sourceId: 'zerobounce.verify',
    sourceDisplayName: 'ZeroBounce',
    inputs: [
      {
        sourceInputKey: 'email',
        label: 'Email to verify',
        required: true,
        matchColumnTypes: ['email'],
        matchColumnKeyPatterns: ['^email$', 'primary_email', 'work_email', 'email_address'],
        hint: 'Any column that holds an email.',
      },
    ],
    output: {
      defaultKey: 'email_status',
      defaultLabel: 'Email status',
      type: 'text',
      outputPath: 'status',
    },
  },

  // ── Find work email ──────────────────────────────────────────────
  {
    id: 'find_work_email',
    label: 'Find work email',
    description:
      'Find the most likely work email for named people at known companies. Input: domain + name.',
    category: 'find',
    rowTypes: ['person', 'custom'],
    sourceId: 'hunter.email_finder',
    sourceDisplayName: 'Hunter',
    inputs: [
      {
        sourceInputKey: 'domain',
        label: 'Company domain',
        required: true,
        matchColumnTypes: ['url'],
        matchColumnKeyPatterns: ['^domain$', 'company_domain', 'website'],
      },
      {
        sourceInputKey: 'firstName',
        label: 'First name',
        required: false,
        matchColumnKeyPatterns: ['first_name', 'firstname', '^first$'],
      },
      {
        sourceInputKey: 'lastName',
        label: 'Last name',
        required: false,
        matchColumnKeyPatterns: ['last_name', 'lastname', '^last$'],
      },
      {
        sourceInputKey: 'fullName',
        label: 'Full name',
        required: false,
        matchColumnKeyPatterns: ['^name$', 'full_name', 'fullname'],
        hint: 'Alternative to first + last name.',
      },
    ],
    output: {
      defaultKey: 'work_email',
      defaultLabel: 'Work email',
      type: 'email',
      outputPath: 'email',
    },
  },

  // ── Enrich company ───────────────────────────────────────────────
  // v1: fills a single column (industry). Users who want the other Apollo
  // fields (employees, revenue, funding, tech stack) add additional
  // enrichment runs for now. v1.1 will land multi-output via a
  // single-flight cache so one Apollo call populates many cells.
  {
    id: 'enrich_company',
    label: 'Enrich company',
    description:
      'Pull industry from Apollo. (More fields — employees, revenue, funding — ship in the next iteration.)',
    category: 'enrich',
    rowTypes: ['company', 'custom'],
    sourceId: 'apollo.organization_enrich',
    sourceDisplayName: 'Apollo',
    inputs: [
      {
        sourceInputKey: 'domain',
        label: 'Company domain',
        required: true,
        matchColumnTypes: ['url'],
        matchColumnKeyPatterns: ['^domain$', 'company_domain', 'website'],
      },
    ],
    output: {
      defaultKey: 'industry',
      defaultLabel: 'Industry',
      type: 'text',
      outputPath: 'organization.industry',
    },
  },

  // ── Enrich person ────────────────────────────────────────────────
  {
    id: 'enrich_person',
    label: 'Enrich person — title',
    description:
      'Pull professional title from Apollo. Input: email or LinkedIn URL. Matches against Apollo’s people database.',
    category: 'enrich',
    rowTypes: ['person', 'custom'],
    sourceId: 'apollo.people_match',
    sourceDisplayName: 'Apollo',
    inputs: [
      {
        sourceInputKey: 'email',
        label: 'Email',
        required: false,
        matchColumnTypes: ['email'],
        matchColumnKeyPatterns: ['^email$', 'work_email', 'primary_email'],
        hint: 'Highest match confidence if provided.',
      },
      {
        sourceInputKey: 'linkedinUrl',
        label: 'LinkedIn URL',
        required: false,
        matchColumnKeyPatterns: ['linkedin_url', 'linkedin'],
      },
    ],
    output: {
      defaultKey: 'title',
      defaultLabel: 'Title',
      type: 'text',
      outputPath: 'person.title',
    },
  },
];

/**
 * Look up an action by id. Returns undefined if not found — callers
 * (backend controller, frontend modal) surface that as a 404.
 */
export function getAction(actionId: string): DataSourceAction | undefined {
  return ACTIONS.find((a) => a.id === actionId);
}

/**
 * Filter actions applicable to a given rowType. Used by the frontend
 * modal to only show actions that make sense for the current table.
 */
export function actionsForRowType(rowType: string): DataSourceAction[] {
  return ACTIONS.filter((a) => a.rowTypes.includes(rowType as DataSourceAction['rowTypes'][number]));
}
