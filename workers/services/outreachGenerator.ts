import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { callLlmOnce, isLlmConfigured } from '../utils/llmClient.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadForOutreach {
  companyName?: string;
  companyDomain?: string;
  website?: string;
  industry?: string;
  address?: { city?: string; country?: string; state?: string };
  socialProfiles?: { linkedinUrl?: string };
  qualificationReason?: string;
  agentReasoning?: string;
  prospectingQuery?: string;
  dynamicFields?: Record<string, unknown>;
}

export interface WorkspaceForOutreach {
  name?: string;
  settings?: { cheapMode?: boolean };
  knowledgeBase?: Array<{ title: string; content: string; type?: string }>;
}

export interface CampaignForOutreach {
  name?: string;
  goal?: string;
  outreachConfig?: { tone?: string; language?: string; channel?: string };
}

export interface OutreachDraftResult {
  firstLine: string;
  subject: string;
  body: string;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// researchCompany
// ---------------------------------------------------------------------------

export async function researchCompany(lead: LeadForOutreach): Promise<string[]> {
  const SERPAPI_KEY = env.SERPAPI_KEY;
  if (!SERPAPI_KEY) return [];

  const companyName = lead.companyName ?? '';
  if (!companyName) return [];

  const year = new Date().getFullYear();
  const query = encodeURIComponent(`"${companyName}" news OR funding ${year}`);
  const url = `https://serpapi.com/search.json?q=${query}&api_key=${SERPAPI_KEY}&num=3`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(t));
    if (!res.ok) {
      logger.warn('[outreachGenerator] SerpAPI returned non-OK status', { status: res.status });
      return [];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const organic: any[] = json?.organic_results ?? [];
    return organic
      .slice(0, 3)
      .map((r) => r?.snippet ?? '')
      .filter(Boolean) as string[];
  } catch (err) {
    logger.warn('[outreachGenerator] researchCompany failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(workspace: WorkspaceForOutreach, campaign: CampaignForOutreach): string {
  const tone = campaign.outreachConfig?.tone ?? 'professional';
  const language = campaign.outreachConfig?.language ?? 'English';

  const kbEntries = (workspace.knowledgeBase ?? [])
    .map((entry) => `## ${entry.title}\n${entry.content}`)
    .join('\n\n');

  const aboutSender = kbEntries.length > 0 ? kbEntries : '(No knowledge base entries provided.)';

  const goalSection = campaign.goal
    ? `\n\nCAMPAIGN GOAL (use to set intent, do not quote verbatim):\n${campaign.goal}`
    : '';

  return `You are a cold outreach personalization agent.

RULES:
- First line must be under 25 words, conversational, anchored to a concrete verifiable detail about this specific company
- Never use generic flattery ("I loved your work on...", "I was impressed by...")
- Each email must be unique — prove it wasn't mass-generated
- Channel: email
- Tone: ${tone}
- Language: ${language}

ABOUT THE SENDER:
${aboutSender}${goalSection}

OUTPUT: Return ONLY valid JSON (no markdown, no explanation):
{
  "firstLine": "...",
  "subject": "...",
  "body": "...",
  "reasoning": "..."
}`;
}

// ---------------------------------------------------------------------------
// buildUserMessage
// ---------------------------------------------------------------------------

function buildUserMessage(lead: LeadForOutreach, snippets: string[]): string {
  const companyName = lead.companyName ?? 'Unknown';
  const companyDomain = lead.companyDomain ?? 'N/A';
  const industry = lead.industry ?? 'N/A';
  const city = lead.address?.city ?? 'N/A';
  const country = lead.address?.country ?? 'N/A';
  const website = lead.website ?? 'N/A';
  const linkedinUrl = lead.socialProfiles?.linkedinUrl ?? 'N/A';

  const researchSection =
    snippets.length > 0
      ? snippets.map((s) => `- ${s}`).join('\n')
      : 'No recent research available.';

  const qualificationSection = lead.qualificationReason
    ? `\n\nWHY THIS LEAD QUALIFIED:\n${lead.qualificationReason}`
    : '';

  const agentReasoningSection = lead.agentReasoning
    ? `\n\nAGENT RESEARCH NOTES:\n${lead.agentReasoning}`
    : '';

  const prospectingSection = lead.prospectingQuery
    ? `\n\nORIGINAL SEARCH BRIEF (use to anchor relevance, do not quote verbatim):\n${lead.prospectingQuery}`
    : '';

  const dynamicSection =
    lead.dynamicFields && Object.keys(lead.dynamicFields).length > 0
      ? `\n\nADDITIONAL FACTS:\n${Object.entries(lead.dynamicFields)
          .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join('\n')}`
      : '';

  return `LEAD:
Company: ${companyName}
Domain: ${companyDomain}
Industry: ${industry}
Location: ${city}, ${country}
Website: ${website}
LinkedIn: ${linkedinUrl}

RECENT RESEARCH (if available):
${researchSection}${qualificationSection}${agentReasoningSection}${prospectingSection}${dynamicSection}

Generate a personalized cold email for this lead.`;
}

// ---------------------------------------------------------------------------
// generateOutreachDraft
// ---------------------------------------------------------------------------

export async function generateOutreachDraft(
  lead: LeadForOutreach,
  workspace: WorkspaceForOutreach,
  campaign: CampaignForOutreach,
  snippets: string[],
): Promise<OutreachDraftResult> {
  if (!isLlmConfigured()) {
    throw new Error('LLM is not configured — set USE_LOCAL_LLM or OPENROUTER_API_KEY');
  }

  const systemPrompt = buildSystemPrompt(workspace, campaign);
  const userMessage = buildUserMessage(lead, snippets);

  const llmResult = await callLlmOnce({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 1000,
    timeoutMs: 30_000,
  });

  if (!llmResult.ok) {
    throw new Error(`LLM returned non-OK status ${llmResult.status}`);
  }

  const content = llmResult.content;

  // Attempt to parse JSON — strip markdown fences if present
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).firstLine !== 'string' ||
    typeof (parsed as Record<string, unknown>).subject !== 'string' ||
    typeof (parsed as Record<string, unknown>).body !== 'string'
  ) {
    throw new Error(
      `AI response did not return valid outreach JSON. Content: ${content.slice(0, 300)}`
    );
  }

  const result = parsed as Record<string, unknown>;
  return {
    firstLine: result.firstLine as string,
    subject: result.subject as string,
    body: result.body as string,
    reasoning: typeof result.reasoning === 'string' ? result.reasoning : '',
  };
}
