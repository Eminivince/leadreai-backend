import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Types (mirror workers/src/services/outreachGenerator.ts — kept in sync manually)
// ---------------------------------------------------------------------------

export interface LeadForOutreach {
  companyName?: string;
  companyDomain?: string;
  website?: string;
  industry?: string;
  address?: { city?: string; country?: string; state?: string };
  socialProfiles?: { linkedinUrl?: string };
  /** Why the prospecting agent selected this lead */
  qualificationReason?: string;
  /** Free-form notes the prospecting agent wrote about this lead */
  agentReasoning?: string;
  /** The original natural-language query that found this lead */
  prospectingQuery?: string;
  /** Query-specific fields (e.g. "pain_point", "recent_news") saved during prospecting */
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
// buildSystemPrompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(workspace: WorkspaceForOutreach, campaign: CampaignForOutreach): string {
  const tone = campaign.outreachConfig?.tone ?? 'professional';
  const language = campaign.outreachConfig?.language ?? 'English';

  const kbEntries = (workspace.knowledgeBase ?? [])
    .map((entry) => `## ${entry.title}\n${entry.content}`)
    .join('\n\n');

  const aboutSender = kbEntries.length > 0 ? kbEntries : '(No knowledge base entries provided.)';
  const campaignGoal = campaign.goal
    ? `CAMPAIGN GOAL: ${campaign.goal}`
    : '';

  return `You are a cold outreach personalization agent.

RULES:
- Write as if you personally researched this lead — because you have context proving you did
- First line must be under 25 words, conversational, anchored to a concrete verifiable detail about this specific lead or company
- Never use generic flattery ("I loved your work on...", "I was impressed by...")
- Use the PROSPECTING CONTEXT section to understand why this lead was selected and what is relevant to them — this is the most important input
- If a qualification reason or agent notes are provided, reference the specific detail that makes this lead relevant
- Each email must be unique — prove it wasn't mass-generated
- Channel: email
- Tone: ${tone}
- Language: ${language}
${campaignGoal}

ABOUT THE SENDER:
${aboutSender}

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

  // Prospecting context — the most valuable signal for personalisation
  const prospectingLines: string[] = [];
  if (lead.prospectingQuery) {
    prospectingLines.push(`Search query that found this lead: "${lead.prospectingQuery}"`);
  }
  if (lead.qualificationReason) {
    prospectingLines.push(`Why this lead was selected: ${lead.qualificationReason}`);
  }
  if (lead.agentReasoning) {
    prospectingLines.push(`Agent notes: ${lead.agentReasoning}`);
  }
  if (lead.dynamicFields && Object.keys(lead.dynamicFields).length > 0) {
    for (const [key, value] of Object.entries(lead.dynamicFields)) {
      if (value != null && value !== '') {
        prospectingLines.push(`${key}: ${String(value)}`);
      }
    }
  }
  const prospectingSection =
    prospectingLines.length > 0
      ? prospectingLines.join('\n')
      : 'No prospecting context available.';

  const researchSection =
    snippets.length > 0
      ? snippets.map((s) => `- ${s}`).join('\n')
      : 'No recent research available.';

  return `LEAD:
Company: ${companyName}
Domain: ${companyDomain}
Industry: ${industry}
Location: ${city}, ${country}
Website: ${website}
LinkedIn: ${linkedinUrl}

PROSPECTING CONTEXT (why this lead was found — use this to personalise the email):
${prospectingSection}

RECENT RESEARCH (if available):
${researchSection}

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
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set — cannot generate outreach draft');
  }

  const systemPrompt = buildSystemPrompt(workspace, campaign);
  const userMessage = buildUserMessage(lead, snippets);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30_000);

  let fetchRes: Response;
  try {
    fetchRes = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://leadreai.app',
        'X-Title': 'LeadreAI',
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        max_tokens: 1500,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(t);
    throw new Error(
      `OpenRouter fetch failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  clearTimeout(t);

  if (!fetchRes.ok) {
    const body = await fetchRes.text().catch(() => '');
    throw new Error(
      `OpenRouter returned non-OK status ${fetchRes.status}: ${body.slice(0, 200)}`
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = await fetchRes.json();
  } catch (err) {
    throw new Error(
      `Failed to parse OpenRouter JSON response: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const content: string = json?.choices?.[0]?.message?.content ?? '';

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
    logger.error('[outreachDraftService] AI response did not return valid JSON', { content: content.slice(0, 300) });
    throw new Error(
      `AI response did not return valid outreach JSON. Content: ${content.slice(0, 300)}`
    );
  }

  const result = parsed as Record<string, unknown>;
  return {
    firstLine: result['firstLine'] as string,
    subject: result['subject'] as string,
    body: result['body'] as string,
    reasoning: typeof result['reasoning'] === 'string' ? result['reasoning'] : '',
  };
}
