/**
 * Canonical test prompts. Each prompt is paired with a machine-gradable rubric.
 * Keep these stable — grading history across runs is only meaningful if the
 * prompt and rubric don't drift.
 *
 * Rubric axes (all 0-100, weighted into a composite):
 *   - coverage:   did the engine find enough real targets?
 *   - accuracy:   are the companies/people real and correctly matched?
 *   - usefulness: can you actually reach someone (usable contact)?
 *   - relevance:  are these the right buyers (persona/ICP/signal match)?
 *   - honesty:    does the engine admit when data is unavailable?
 */
export interface PromptSpec {
  id: string;
  title: string;
  query: string;
  expectedTargetCount: number;
  /** What a "strong" result looks like — soft minimums for composite scoring. */
  strongMinimums: {
    totalLeads: number;           // at least this many usable leads
    withBusinessEmail?: number;   // at least this many with a business email (not personal)
    withNamedContact?: number;    // at least this many with a named decision-maker
    withSignal?: number;          // for trigger-based: at least this many with a signal
  };
  /** Axis weights for composite; must sum to 1. */
  axisWeights: { coverage: number; accuracy: number; usefulness: number; relevance: number; honesty: number };
  /** Red flags — any hit reduces honesty score heavily. */
  redFlags: {
    personalEmailDomains?: string[];  // gmail.com, yahoo.com — flagged if appearing as "business"
    maxDupePhonesAcrossCompanies?: number;  // same phone on N+ companies = hallucination signal
    requireSourceForEveryContact?: boolean;
  };
}

const GENERIC_PERSONAL_DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com'];

export const PROMPTS: PromptSpec[] = [
  {
    id: 'p1-fintech-decision-makers',
    title: 'Straight company + decision-maker discovery',
    query:
      'Get me the top 50 fintech companies in Nigeria. For each company, find the founder, CEO, Head of Growth, or Head of Partnerships. Return company name, website, LinkedIn, company size, city, person name, title, work email, business phone, and source links.',
    expectedTargetCount: 50,
    strongMinimums: { totalLeads: 35, withBusinessEmail: 20, withNamedContact: 20 },
    axisWeights: { coverage: 0.25, accuracy: 0.25, usefulness: 0.2, relevance: 0.2, honesty: 0.1 },
    redFlags: {
      personalEmailDomains: GENERIC_PERSONAL_DOMAINS,
      maxDupePhonesAcrossCompanies: 2,
      requireSourceForEveryContact: true,
    },
  },
  {
    id: 'p2-law-firms-partners',
    title: 'Harder vertical — law firms with decision-makers',
    query:
      'Find the top 100 law firms in Nigeria. For each firm, get the managing partner, senior partner, head of corporate/commercial practice, or business development lead. Return website, office city, practice areas, public business email, public phone number, and direct work email if available.',
    expectedTargetCount: 100,
    strongMinimums: { totalLeads: 70, withBusinessEmail: 50, withNamedContact: 20 },
    axisWeights: { coverage: 0.2, accuracy: 0.25, usefulness: 0.2, relevance: 0.15, honesty: 0.2 },
    redFlags: {
      personalEmailDomains: GENERIC_PERSONAL_DOMAINS,
      maxDupePhonesAcrossCompanies: 2,
      requireSourceForEveryContact: true,
    },
  },
  {
    id: 'p3-icp-payments-infra',
    title: 'ICP-based list building — payments infrastructure buyers',
    query:
      'Build me a prospect list of 75 Nigerian companies that are likely to need payment infrastructure. Focus on e-commerce, logistics, marketplaces, SaaS, travel, and fintech-adjacent businesses with active websites. Find the CTO, Head of Engineering, Product Lead, or COO. Include company type, why they fit the ICP, tech signals if available, and best contact path.',
    expectedTargetCount: 75,
    strongMinimums: { totalLeads: 50, withNamedContact: 30 },
    axisWeights: { coverage: 0.15, accuracy: 0.2, usefulness: 0.15, relevance: 0.4, honesty: 0.1 },
    redFlags: { personalEmailDomains: GENERIC_PERSONAL_DOMAINS, maxDupePhonesAcrossCompanies: 2, requireSourceForEveryContact: true },
  },
  {
    id: 'p4-trigger-legal-compliance-payments',
    title: 'Trigger-based prospecting — buying signals',
    query:
      'Find 50 companies in Nigeria and Kenya that have shown recent buying signals for legal, compliance, or payments software. Signals can include hiring, expansion, fundraising, launching new products, licensing activity, or cross-border operations. For each company, find the best decision-maker and the evidence for the signal.',
    expectedTargetCount: 50,
    strongMinimums: { totalLeads: 20, withNamedContact: 15, withSignal: 20 },
    axisWeights: { coverage: 0.1, accuracy: 0.2, usefulness: 0.15, relevance: 0.3, honesty: 0.25 },
    redFlags: { personalEmailDomains: GENERIC_PERSONAL_DOMAINS, maxDupePhonesAcrossCompanies: 2, requireSourceForEveryContact: true },
  },
  {
    id: 'p5-mid-tier-manufacturers',
    title: 'Brutal edge case — mid-sized manufacturers',
    query:
      'Get me 100 mid-sized manufacturing companies in Nigeria outside the obvious blue-chip names. For each, find procurement, operations, supply chain, finance, or IT leadership. Return company website, location, business line, named contacts, public business emails, direct work emails if available, and confidence score for each field.',
    expectedTargetCount: 100,
    strongMinimums: { totalLeads: 40, withBusinessEmail: 25, withNamedContact: 15 },
    // Honesty weighted heaviest — this prompt is specifically about not lying when data is thin.
    axisWeights: { coverage: 0.1, accuracy: 0.2, usefulness: 0.1, relevance: 0.15, honesty: 0.45 },
    redFlags: { personalEmailDomains: GENERIC_PERSONAL_DOMAINS, maxDupePhonesAcrossCompanies: 1, requireSourceForEveryContact: true },
  },
];

export function getPromptById(id: string): PromptSpec | undefined {
  return PROMPTS.find((p) => p.id === id);
}
