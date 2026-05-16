export type SeniorityLevel = 'c_level' | 'vp' | 'director' | 'manager' | 'ic' | 'unknown';
export type Department = 'sales' | 'marketing' | 'engineering' | 'finance' | 'hr' | 'legal' | 'operations' | 'other';

const C_LEVEL = ['ceo', 'cto', 'cfo', 'coo', 'cmo', 'cpo', 'president', 'founder', 'co-founder', 'managing director', 'managing partner', 'principal'];
const VP = ['vice president', 'vp ', 'svp', 'evp'];
const DIRECTOR = ['director', 'head of', 'global head'];
const MANAGER = ['manager', 'lead', 'team lead', 'senior manager'];

const DEPT_MAP: Record<Department, string[]> = {
  sales: ['sales', 'account executive', 'business development', 'bd ', 'ae ', 'sdr', 'bdr', 'revenue'],
  marketing: ['marketing', 'growth', 'demand generation', 'brand', 'content', 'seo'],
  engineering: ['engineer', 'developer', 'cto', 'technology', 'infrastructure', 'devops', 'platform'],
  finance: ['finance', 'cfo', 'accounting', 'controller', 'treasury'],
  hr: ['people', 'hr ', 'human resources', 'talent', 'recruiting'],
  legal: ['legal', 'counsel', 'compliance', 'general counsel'],
  operations: ['operations', 'ops ', 'coo', 'supply chain', 'logistics'],
  other: [],
};

export interface SeniorityResult {
  seniority: SeniorityLevel;
  department: Department;
}

export function mapSeniority(title: string): SeniorityResult {
  if (!title || !title.trim()) return { seniority: 'unknown', department: 'other' };
  const lower = title.toLowerCase();
  let seniority: SeniorityLevel = 'ic';

  if (C_LEVEL.some(k => lower.includes(k))) seniority = 'c_level';
  else if (VP.some(k => lower.includes(k))) seniority = 'vp';
  else if (DIRECTOR.some(k => lower.includes(k))) seniority = 'director';
  else if (MANAGER.some(k => lower.includes(k))) seniority = 'manager';
  else seniority = 'ic';

  let department: Department = 'other';
  for (const [dept, keywords] of Object.entries(DEPT_MAP) as [Department, string[]][]) {
    if (dept === 'other') continue;
    if (keywords.some(k => lower.includes(k))) {
      department = dept;
      break;
    }
  }

  return { seniority, department };
}
