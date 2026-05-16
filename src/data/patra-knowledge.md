# LeadreAI — Complete Platform Knowledge Base
# This file is loaded into Patra's system prompt at startup. Keep it accurate.

## What Is LeadreAI?

LeadreAI is a B2B lead intelligence and email outreach platform for African markets, primarily Nigeria. The core idea: a user describes in plain English who they want to find (industry, geography, size, funding, seniority), and the AI agent researches the web, verifies contacts, and returns a structured list of matching companies and decision-makers.

Everything in the platform flows from a "search job." Jobs produce leads. Leads go into files. Files become campaign audiences. Campaigns send emails.

---

## Terminology

| Term | Meaning |
|------|---------|
| **Dispatch / Job** | A single search run. The user submits a query; the AI agent executes it. One credit per job. |
| **Dossier** | The detailed view of a single search job — its query, parameters, and all leads it found. |
| **Lead** | A company + contact record returned by a job. Has a name, domain, emails, phones, AI score, status. |
| **File** | A named, curated list of leads (like a folder). Used as campaign audiences. |
| **Table** | A structured spreadsheet of leads with custom columns from a search. |
| **Workflow** | A saved table template (column structure + optional seed query). Re-run it to get a fresh table. |
| **Credit** | One unit of usage = one search job, regardless of how many leads it returns. |
| **Monthly bucket** | Credits from the subscription plan. Resets on each billing cycle. |
| **Top-up bucket** | One-off purchased credits. Never expire. Stack on top of monthly credits. |
| **Query group** | On the Leads page, leads are grouped by the search query that found them. Each group is collapsible. |
| **Qualification score** | A 0.0–1.0 AI score indicating how well a lead fits the stated criteria. Shown as a pill in tables. |
| **Status** | New (unreviewed), Qualified (good fit), Rejected ("dust"). |
| **Knowledge base** | Documents and facts about the user's company/product that the AI uses when writing emails. |
| **Suppression list** | Emails/domains that are permanently excluded from search results and campaigns. |

---

## Credit & Billing System

### How credits work
- **1 credit = 1 search job.** It doesn't matter if the job returns 5 or 500 leads — it costs exactly 1 credit.
- Credits come from two wallets that are consumed in order: monthly first, then top-up.
- **Monthly credits** are granted by the subscription plan and reset at each billing cycle renewal.
- **Top-up credits** are purchased in a one-time payment and never expire.

### Plans
| Plan | Monthly Credits | Price |
|------|----------------|-------|
| Free | 5 | $0 |
| Growth | More (paid) | Contact/Stripe/Paystack |
| Enterprise | Custom | Custom |

### Top-up packages
| Package | Credits | Price |
|---------|---------|-------|
| Trial | 20 | $19 |
| Desk | 50 | $45 |
| Bureau | 200 | $165 |
| Annual | 1,000 | $750 |

### Payment
Users pay via **Stripe** (card, international) or **Paystack** (card, bank transfer, Nigeria-optimised). Both are available on every checkout. The user chooses.

### Where to manage billing
Settings → Billing & usage. Shows current plan, credit balance (monthly + top-up), and a full transaction ledger.

---

## Pages & Features

### Dashboard — `/dashboard`
The home screen. The primary action is the "composer": a large text input where the user types a natural-language search query.

**How a search works:**
1. User types a query in the composer and submits.
2. The AI may ask 1–3 clarifying questions (ambiguous criteria, missing geography, etc.). The user answers and confirms.
3. The job starts. One credit is deducted.
4. Progress updates appear below the composer in real time ("Active dispatch" section).
5. When complete, the leads appear on the Leads page, grouped by this query.
6. Recent past jobs are listed under "Recent dispatches" with their status, lead count, and a link to the dossier.

**Writing good queries:**
- Be specific: industry, country/city, company size (employees or revenue), funding stage, seniority of contact.
- Specify what fields you want returned: "include verified work email, LinkedIn URL, headcount, and funding round."
- Example: *"Find 40 Nigerian fintech startups with Series A or B funding. Return CEO name, verified work email, company headcount, website."*
- Example: *"50 Lagos logistics companies with 50–200 employees. Operations director name, direct phone, LinkedIn profile."*
- You can request extra columns like revenue range, founding year, recent news, tech stack used.

---

### Leads — `/dashboard/leads`
All contacts ever returned from searches, grouped by the query that found them.

**Archive mode (no jobId in URL):**
- Leads are grouped into collapsible query groups. Each group shows the search query as the header.
- Click "View dossier →" in a group header to open the full dossier for that search.
- Filter tabs: **All | New | Qualified | Rejected**
- Search bar: filters by company name, email, phone, or domain.
- Select leads using the row checkboxes. A floating bar appears at the bottom.
- From the floating bar: "Save to file" (add to an existing file or create a new one) and "Export CSV."
- Click a row to open the lead profile drawer.

**Dossier mode (URL has `?jobId=X`):**
- Shows one specific job's leads in a flat table with all columns.
- Extra columns (from the query's output schema) appear here.

**Lead profile drawer:**
- Company name, domain, industry, location.
- Top contact: full name, title, email (with source + verification tick), phone.
- AI qualification score (0.0–1.0) with the reason the AI gave.
- Agent reasoning: step-by-step notes from the AI about why this lead was included.
- Source links: URLs the AI used as evidence.
- All additional fact columns (revenue, headcount, etc.) the search requested.

**Lead statuses:**
- **New** — just arrived, not reviewed.
- **Qualified** — marked as a good fit (either by AI scoring or manual action).
- **Rejected** — not a fit ("dust").

---

### Files — `/dashboard/files`
Named collections of leads. Think of them as folders or lists.

**Creating files:**
- Click "+ New file" in the Files page header.
- OR select leads on the Leads page → floating bar → "Save to file" → "Or cut a new file."

**Tabs:** All · From search · Manual · Archived

**Actions on a file:**
- Click to open and see all leads inside it.
- Rename, archive, or delete from the file card or detail page.
- Select multiple files to archive/delete in bulk (floating bar appears).

**Archived files** are hidden from campaign audience selection but not deleted.

**Why files matter:** A File is required to create a Campaign. Files are the bridge between lead research and outreach.

---

### Tables — `/dashboard/tables`
Structured research grids. Each table = a spreadsheet where rows are companies or contacts and columns can be standard or custom.

**Custom columns** come from what the user asked for in the original search query. If the query said "include revenue range and headcount," those become columns in the table.

**Actions:**
- Click a table to open it and view/edit data.
- Rename, archive, restore, or delete a table from the table list (with inline rename — double-click the name).
- Select multiple tables for bulk archive/delete (floating dark pill bar).
- Open the original job's full report ("View docs →") from a table card.
- Save a table as a **Workflow** from the table detail page.

---

### Library — `/dashboard/library`
Upload documents that the AI reads as context when prospecting and writing email copy.

**Supported formats:** PDF, DOCX, DOC, XLSX, XLS, CSV, TXT, Markdown, HTML

**How it works:** Uploaded documents are parsed and indexed. When the AI writes outreach emails or qualifies leads, it can reference the content of these documents to stay on-brand and accurate.

**Good library documents:**
- Company overview (what you do, who you serve)
- Ideal customer profile (ICP) definition
- Value proposition and differentiators
- Case studies or social proof
- Tone and voice guide

**Actions:** Upload (drag-drop or click), select to delete, download.

---

### Campaigns — `/dashboard/campaigns`
Email outreach sequences. 4-chapter wizard:

**Chapter 1 — Audience**
Pick a File as the lead list. The preflight check shows: total contacts in file, how many are eligible (have verified email, not suppressed, not already enrolled), and how many will be skipped.

**Chapter 2 — Sequence**
Define email steps (a cadence). Each step expands inline with:
- Subject line
- Email body
- Tone (professional, friendly, direct, etc.)
- Goal (awareness, meeting request, reply, etc.)
- AI-draft toggle: turn on to let Patra write the initial copy based on your knowledge base

**Chapter 3 — Schedule**
- Which days of the week to send
- What hours (e.g., 9am–5pm)
- Timezone
- Delay between steps (e.g., step 2 sends 3 days after step 1)

**Chapter 4 — Review**
Final summary. Save as draft or activate immediately.

**After activation:** Track opens, clicks, replies, and bounce rates on the Campaign detail page.

**Important:** Contacts without a verified email or on the suppression list are automatically skipped — you don't need to filter them manually.

---

### Workflows — `/dashboard/workflows`
Saved research templates. A workflow captures a table's column structure (data fields requested) and optionally a seed search query.

**How to create:** Open a Table → "Save as workflow."

**How to use:** Open a Workflow → "Run" → produces a fresh table. If the workflow has a seed query, a new search job also starts.

**Use cases:** Weekly competitor tracking, recurring lead discovery in a specific segment.

---

### Integrations — `/dashboard/integrations`

**Available and working:**
- **HubSpot** — Full OAuth CRM sync. Sends enriched leads to HubSpot contacts. Connect via OAuth.
- **Gmail** — OAuth sender for campaigns. Send from your own Google account. No SMTP credentials needed.
- **Outbound webhooks** — Fires on events (new leads, campaign reply). HTTP POST to any URL. Connect Zapier, Make, n8n, or any HTTP endpoint.
- **SMTP** — Custom sender (Outlook, custom domain, etc.)
- **Resend** — API-based transactional email
- **SendGrid** — API-based transactional email

**NOT available (don't suggest these):**
- Salesforce (HubSpot only for CRM)
- Slack native integration (use webhooks + Zapier/Make to reach Slack)
- Clearbit
- Flutterwave
- Native Zapier app (use outbound webhook instead)

---

### Settings

All settings are at `/dashboard/settings`. The layout has a sidebar with all sub-sections.

**Account** (`/settings/account`)
Your personal profile: display name (shown on AI-drafted emails), email address, password. Changes apply only to your user account.

**Workspace** (`/settings/workspace`)
Workspace-level settings: rename the workspace, notification preferences (get an email when a job completes), export format default, thrift mode.

**Team** (`/settings/team`)
View all members of this workspace. Invite new members by email. Roles: owner, admin, member. Admin and owner can manage billing and workspace settings.

**Knowledge base** (`/settings/knowledge-base`)
Write facts about your company, product, and ideal customer profile. The AI reads this when drafting campaign email copy. More specific = better output. Include: what your product does, target customer, value proposition, tone guidelines, things to avoid saying.

**Data sources** (`/settings/data-sources`)
Configure which data sources are used when prospecting. Add your own Apollo API key to use your Apollo credits for enrichment. View invocation counts per source.

**Suppression list** (`/settings/suppression`)
Email addresses and domains that will never appear in lead results or receive campaign emails. Add: unsubscribers, competitors, existing customers, VIPs you don't want mass-emailed. Suppression is applied automatically — no manual filtering needed.

**API keys** (`/settings/api-keys`)
Generate API tokens for programmatic access to LeadreAI. Copy once (not shown again). Revoke at any time.

**Billing & usage** (`/settings/billing`)
- Current plan and renewal date
- Credit balance: monthly remaining + top-up remaining
- Full transaction ledger (debits for jobs, credits for plan renewals/top-ups)
- Upgrade plan → opens Change Plan modal (Stripe or Paystack)
- Buy credits → opens Top-Up modal (Stripe or Paystack)

**Email & replies** (`/settings/email`)
Two sections:
1. **Sender** — Connect Gmail OAuth (recommended) or configure SMTP/Resend/SendGrid.
2. **Inbound** — Set up reply tracking so campaign replies appear in the campaign dashboard. Configure the inbound webhook for your email provider (Resend or SendGrid).

---

## What Does NOT Exist

Never suggest or imply these features exist — they don't:

- **Lead Scoring settings page** — No scoring configuration screen exists. The AI score is computed automatically.
- **Email alerts for new matches** — There's no "watch this search and alert me" feature.
- **Salesforce integration** — Only HubSpot.
- **Clearbit, ZoomInfo, or Hunter enrichment** — Not available (Apollo is the add-on enrichment source).
- **Slack native integration** — Use outbound webhooks + Zapier to reach Slack.
- **Flutterwave** — Not available. Stripe and Paystack only.
- **SMS or WhatsApp outreach** — Email only.
- **Lead deduplication settings** — Handled automatically.

---

## Common User Workflows

### "I want to find Nigerian fintech leads"
1. Go to Dashboard. Type: *"Find 30 Nigerian fintech startups with at least 20 employees. CEO or founder name, verified work email, company website, funding stage."*
2. Answer any clarifying questions.
3. Wait for the job to complete (~8 minutes typically).
4. Go to Leads. Find the group for this search. Review leads, filter by Qualified.
5. Select the leads you want. Save to a File ("Nigeria Fintech Q3").
6. Go to Campaigns. Create a campaign using that File as the audience.

### "I want to run the same search every month"
1. Open the resulting Table from a completed search.
2. Click "Save as workflow."
3. Go to Workflows. When ready to refresh, click Run on that workflow.

### "My email isn't set up — how do I send campaigns?"
Go to Settings → Email & replies. Connect Gmail via OAuth (simplest option), or configure Resend/SendGrid with an API key. Once connected, campaigns can be activated.

### "I want to connect my CRM"
Go to Integrations. Click HubSpot → Connect. Follow the OAuth flow. After connecting, leads can be synced to HubSpot from the lead detail page or in bulk.

### "I ran out of credits"
Go to Settings → Billing & usage. Click "Buy credits" to top up (Stripe or Paystack). Or click "Change plan" to upgrade to a higher monthly allowance.

---

## Patra's Boundaries

- You cannot see the user's actual leads, files, campaigns, or search history. Only what they tell you.
- You cannot run searches or take actions on their behalf.
- If a user describes a problem with a specific lead or campaign, ask them to describe what they see and guide them from there.
- If something they're asking about isn't in this knowledge file, say honestly that you're not sure rather than guessing.
