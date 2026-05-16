/* eslint-disable */
// Auto-generated from patra-knowledge.md — edit that file, not this one.
// This TS module is the build-safe way to embed the knowledge without fs.readFileSync path issues.

export const PATRA_KNOWLEDGE = `
# LeadreAI — Complete Platform Knowledge Base

## What Is LeadreAI?

LeadreAI is a B2B lead intelligence and email outreach platform for African markets, primarily Nigeria. The core idea: a user describes in plain English who they want to find (industry, geography, size, funding, seniority), and the AI agent researches the web, verifies contacts, and returns a structured list of matching companies and decision-makers.

Everything in the platform flows from a "search job." Jobs produce leads. Leads go into files. Files become campaign audiences. Campaigns send emails.

---

## Terminology

- **Dispatch / Job** — A single search run. The user submits a query; the AI agent executes it. One credit per job.
- **Dossier** — The detailed view of a single search job — its query, parameters, and all leads it found.
- **Lead** — A company + contact record returned by a job. Has a name, domain, emails, phones, AI score, status.
- **File** — A named, curated list of leads (like a folder). Used as campaign audiences.
- **Table** — A structured spreadsheet of leads with custom columns from a search.
- **Workflow** — A saved table template (column structure + optional seed query). Re-run it to get a fresh table.
- **Credit** — One unit of usage = one search job, regardless of how many leads it returns.
- **Monthly bucket** — Credits from the subscription plan. Resets on each billing cycle.
- **Top-up bucket** — One-off purchased credits. Never expire. Stack on top of monthly credits.
- **Query group** — On the Leads page, leads are grouped by the search query that found them. Each group is collapsible.
- **Qualification score** — A 0.0–1.0 AI score indicating how well a lead fits the stated criteria. Shown as a pill in tables.
- **Status** — New (unreviewed), Qualified (good fit), Rejected ("dust").
- **Knowledge base** — Documents and facts about the user's company/product that the AI uses when writing emails.
- **Suppression list** — Emails/domains that are permanently excluded from search results and campaigns.

---

## Credit & Billing System

### How credits work
- **1 credit = 1 search job.** It doesn't matter if the job returns 5 or 500 leads — it costs exactly 1 credit.
- Credits come from two wallets consumed in order: monthly first, then top-up.
- **Monthly credits** are granted by the subscription plan and reset at each billing cycle renewal.
- **Top-up credits** are purchased in a one-time payment and never expire.

### Plans
- Free: 5 credits/month, $0
- Growth: More credits, paid (Stripe or Paystack)
- Enterprise: Custom credits, custom pricing

### Top-up packages
- Trial: 20 credits, $19
- Desk: 50 credits, $45
- Bureau: 200 credits, $165
- Annual: 1,000 credits, $750

### Payment providers
Stripe (card, international) or Paystack (card, bank transfer, Nigeria-optimised). Users choose at checkout.

### Where to manage billing
Settings → Billing & usage. Shows plan, credit balance (monthly + top-up), and a transaction ledger.

---

## Pages & Features

### Dashboard — /dashboard
The home screen. The composer: a large text input where the user types a natural-language search query.

**How a search works:**
1. User types a query and submits.
2. The AI may ask 1–3 clarifying questions. The user answers and confirms.
3. The job starts. One credit is deducted.
4. Progress updates appear below the composer in real time.
5. When complete, leads appear on the Leads page grouped by this query.
6. Recent jobs are listed under "Recent dispatches."

**Writing good queries — be specific:**
- Include industry, country/city, company size, funding stage, seniority.
- Specify which fields to return: "include verified work email, LinkedIn URL, headcount, funding round."
- Example: "Find 40 Nigerian fintech startups with Series A or B funding. Return CEO name, verified work email, company headcount, website."
- Example: "50 Lagos logistics companies with 50–200 employees. Operations director name, direct phone, LinkedIn profile."
- Extra columns you can request: revenue range, founding year, recent news, tech stack, social profiles.

---

### Leads — /dashboard/leads
All contacts ever returned from searches, grouped by the query that found them.

**Archive mode (default view):**
- Leads in collapsible query groups. Each group header shows the search query.
- "View dossier →" on a group header opens the full dossier for that search.
- Filter tabs: All | New | Qualified | Rejected
- Search bar: company name, email, phone, domain.
- Row checkboxes: select leads → floating action bar → "Save to file" or "Export CSV."
- Click a row to open the lead profile drawer.

**Dossier mode (URL has ?jobId=X):**
- Flat table of one job's leads with all custom columns.

**Lead profile drawer contents:**
- Company name, domain, industry, location.
- Top contact: full name, title, email (source + verification), phone.
- AI qualification score (0.0–1.0) with the AI's stated reason.
- Agent reasoning: step-by-step AI notes on why this lead was included.
- Source links: URLs the AI used as evidence.
- All extra fact columns (revenue, headcount, etc.) from the search.

**Lead statuses:**
- New — just arrived, not reviewed.
- Qualified — marked as a good fit.
- Rejected — not a fit ("dust").

---

### Files — /dashboard/files
Named collections of leads (folders/lists). Required for campaigns.

**Creating files:**
- Click "+ New file" on the Files page.
- Or select leads on the Leads page → floating bar → "Save to file" → "Or cut a new file."

**Tabs:** All · From search · Manual · Archived

**Per-file actions:** Open, rename, archive, delete.

**Bulk actions:** Select multiple files → floating bar → archive or delete.

**Archived files** are hidden from campaign audience selection but not deleted.

A File is the bridge between research and outreach — you cannot create a campaign without one.

---

### Tables — /dashboard/tables
Structured research grids. Rows = companies or contacts. Columns = standard or custom fields.

Custom columns come from what the search query asked for. If the query said "include revenue range and headcount," those become columns.

**Actions:**
- Click to open and view/edit data.
- Rename (inline, double-click the name), archive, restore, delete.
- Bulk select → floating bar → archive or delete.
- "View docs →" opens the original job's full report.
- "Save as workflow" from the table detail page.

---

### Library — /dashboard/library
Upload documents so the AI has context when writing emails and qualifying leads.

**Supported formats:** PDF, DOCX, DOC, XLSX, XLS, CSV, TXT, Markdown, HTML

Uploaded files are parsed and indexed automatically. The AI references them when drafting campaign copy.

**Useful documents to upload:**
- Company overview (what you do, who you serve)
- ICP definition
- Value proposition and differentiators
- Case studies or social proof
- Tone and voice guidelines

**Actions:** Upload (click or drag-drop), bulk delete, download.

---

### Campaigns — /dashboard/campaigns
Email outreach sequences. 4-chapter wizard.

**Chapter 1 — Audience**
Pick a File as the contact list. Preflight check shows eligible vs. skipped contacts (no verified email, suppressed, already enrolled).

**Chapter 2 — Sequence**
Define email steps. Each step has:
- Subject line
- Email body
- Tone (professional, friendly, direct, etc.)
- Goal (awareness, meeting request, etc.)
- AI-draft toggle (Patra writes initial copy from your knowledge base)

**Chapter 3 — Schedule**
- Days of week to send
- Hours (e.g., 9am–5pm)
- Timezone
- Delay between steps

**Chapter 4 — Review**
Final summary. Save as draft or activate.

After activation: track opens, clicks, replies, bounces on the Campaign detail page.

Contacts without verified email or on suppression list are automatically skipped.

---

### Workflows — /dashboard/workflows
Saved research templates. Captures table column structure + optional seed query.

**Create:** Open a Table → "Save as workflow."
**Use:** Open a Workflow → "Run" → fresh table. If seed query present, new search job also starts.
**Use cases:** Weekly competitor tracking, recurring lead discovery.

---

### Integrations — /dashboard/integrations

**Available and working:**
- HubSpot — Full OAuth CRM sync. Sends enriched leads to HubSpot contacts.
- Gmail — OAuth sender. Send campaigns from your own Google account. No SMTP credentials needed.
- Outbound webhooks — HTTP POST on new leads or campaign replies. Connect Zapier, Make, n8n, or any endpoint.
- SMTP — Custom sender (Outlook, custom domain, etc.)
- Resend — API-based transactional email
- SendGrid — API-based transactional email

**NOT available — never suggest these:**
- Salesforce (HubSpot only for CRM)
- Slack native integration (use webhooks + Zapier to reach Slack)
- Clearbit
- Flutterwave
- Native Zapier app (outbound webhook is the right approach)

---

### Settings — /dashboard/settings

**Account** (/settings/account) — Display name, email, password. Personal only.

**Workspace** (/settings/workspace) — Rename workspace, notification on job complete, export format, thrift mode.

**Team** (/settings/team) — View members. Invite by email. Roles: owner, admin, member.

**Knowledge base** (/settings/knowledge-base) — Company facts, value proposition, ICP, tone guidelines for AI email copy. More specific = better AI output.

**Data sources** (/settings/data-sources) — Enable/disable sources. Add Apollo API key for enrichment. View invocation counts.

**Suppression list** (/settings/suppression) — Emails/domains never contacted. Applied automatically to all searches and campaigns.

**API keys** (/settings/api-keys) — Generate tokens for programmatic API access. Copy once, revoke anytime.

**Billing & usage** (/settings/billing) — Plan, credits balance, transaction ledger. Upgrade plan or buy top-up credits (Stripe or Paystack).

**Email & replies** (/settings/email) — Sender config (Gmail OAuth recommended, or SMTP/Resend/SendGrid). Inbound reply webhook config.

**There is NO Lead Scoring settings page. There is NO scoring configuration screen. Scores are computed automatically.**

---

## Features That Do NOT Exist

Never suggest or imply any of these:
- Lead Scoring settings / scoring configuration
- Email alerts for new matches ("watch this search")
- Salesforce integration
- Clearbit, ZoomInfo, or Hunter enrichment
- Slack native integration
- Flutterwave payments
- SMS or WhatsApp outreach
- Manual lead deduplication settings

---

## Common User Workflows

**Find Nigerian fintech leads:**
1. Dashboard → type: "Find 30 Nigerian fintech startups with at least 20 employees. CEO name, verified work email, website, funding stage."
2. Answer clarifying questions.
3. Wait ~8 minutes for job to complete.
4. Leads page → find group → review → filter by Qualified.
5. Select leads → Save to file ("Nigeria Fintech Q3").
6. Campaigns → create campaign with that file as audience.

**Run same search monthly:**
1. Open Table from completed search.
2. "Save as workflow."
3. Workflows → Run when ready.

**Set up email sending:**
Settings → Email & replies → Connect Gmail (simplest). Or configure Resend/SendGrid with API key.

**Connect CRM:**
Integrations → HubSpot → Connect → follow OAuth flow.

**Ran out of credits:**
Settings → Billing & usage → "Buy credits" (top-up, Stripe or Paystack) or "Change plan" (upgrade subscription).

---

## Patra's Limitations

- Cannot see the user's actual data (leads, files, campaigns, search history).
- Cannot run searches or take actions on the user's behalf.
- If something isn't in this knowledge base, say so honestly rather than guessing.
`;
