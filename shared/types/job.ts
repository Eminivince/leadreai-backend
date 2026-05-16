export type JobStatus =
  | 'queued'
  | 'parsing'
  | 'collecting'
  | 'enriching'
  | 'deduplicating'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface JobGeography {
  country?: string | null;
  state?: string | null;
  city?: string | null;
}

// FactType / OutputSchemaColumn / FactValue are defined in
// ../schemas/zod/job.schemas.ts (as Zod-inferred types, the source of truth
// for runtime validation). Re-export here for convenience; don't re-declare.
export type { FactType, OutputSchemaColumn, FactValue } from '../schemas/zod/job.schemas.js';
export type {
  ClarificationQuestion,
  ClarificationQuestionType,
  ClarificationAnswer,
  ClarifyRequest,
  ClarifyResponse,
  PolicyDecision,
} from '../schemas/zod/job.schemas.js';

export interface ParsedIntent {
  /** Null when the query names a specific company without industry context; enrichment fills it in later. */
  industry?: string | null;
  subIndustry?: string | null;
  geography: JobGeography;
  targetCount: number;
  desiredFields: string[];
  companySize?: string | null;
  keywords: string[];
  confidenceScore: number;
  /** 'named_entity_list' = "top 10 law firms in Nigeria"; 'contact_lookup' = asking for specific contact of a named org; 'demographic_filter' = filter-based prospecting */
  queryType: 'named_entity_list' | 'demographic_filter' | 'contact_lookup';
  /** For named_entity_list: specific company/org names mentioned or to be resolved. null = resolve via search. */
  namedEntities: string[] | null;
  /** Extra columns the user asked for. Empty array for queries that only ask for the standard contact fields. */
  outputSchema?: import('../schemas/zod/job.schemas.js').OutputSchemaColumn[];
  /** What the app's user is selling or offering (e.g. "corporate travel booking services for SMEs").
   *  Extracted by the query parser when present; used by the hybrid discovery prompt to generate
   *  concrete fit-reasons per candidate. Null when the query gives no indication. */
  userOffering?: string | null;
}

export interface JobProgress {
  percentage: number;
  currentStage: string;
  stagesComplete: string[];
  leadsFoundSoFar: number;
}

export interface JobResult {
  totalLeadsFound: number;
  totalAfterDedup: number;
  dorkQueriesUsed: string[];
  sourcesScraped: string[];
  filesDownloaded: number;
  durationMs: number;
}

export interface JobError {
  message: string;
  stack?: string;
  stage: string;
}

/** Human-readable pipeline step for debugging / tuning (streamed over SSE + stored on job). */
export interface JobActivityLogEntry {
  at: string;
  step: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface ProspectingJob {
  _id: string;
  workspaceId: string;
  createdBy: string;
  rawQuery: string;
  clarifications?: import('../schemas/zod/job.schemas.js').ClarificationAnswer[];
  parsedIntent?: ParsedIntent;
  status: JobStatus;
  progress: JobProgress;
  result?: JobResult;
  error?: JobError;
  /** Append-only run log (newest capped server-side). Shown in dashboard job cards. */
  activityLog?: JobActivityLogEntry[];
  bullmqJobId?: string;
  creditsCharged: number;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}
