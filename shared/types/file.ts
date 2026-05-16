export type FileSource = 'job' | 'manual';

export interface LeadFile {
  _id: string;
  workspaceId: string;
  createdBy: string;
  name: string;
  description?: string;
  source: FileSource;
  sourceJobId?: string;
  leadIds: string[];
  color?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeadFileSummary {
  _id: string;
  name: string;
  description?: string;
  source: FileSource;
  sourceJobId?: string;
  leadCount: number;
  archivedAt?: string;
  updatedAt: string;
  createdAt: string;
}
