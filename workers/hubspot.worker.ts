import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';

// ---------------------------------------------------------------------------
// Inline Mongoose models (strict:false — workers never import from backend)
// ---------------------------------------------------------------------------
const workspaceSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Workspace: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Workspace'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Workspace', workspaceSchema, 'workspaces');

const leadSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Lead: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Lead'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Lead', leadSchema, 'leads');

const contactSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Contact: mongoose.Model<any> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mongoose.models['Contact'] as mongoose.Model<any> | undefined) ??
  mongoose.model('Contact', contactSchema, 'contacts');

// ---------------------------------------------------------------------------
// Inlined decrypt — mirrors backend/src/utils/encrypt.ts
// Encryption key: derived from JWT_SECRET via scrypt (same salt)
// ---------------------------------------------------------------------------
function getDecryptKey(): Buffer {
  const secret = env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not set — cannot decrypt HubSpot tokens');
  return scryptSync(secret, 'leadreai-email-salt', 32);
}

function decrypt(ciphertext: string): string {
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
  if (!ivHex || !authTagHex || !encryptedHex) throw new Error('Invalid ciphertext format');
  const key = getDecryptKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return decipher.update(Buffer.from(encryptedHex, 'hex')) + decipher.final('utf8');
}

// Inlined encrypt — mirrors backend/src/utils/encrypt.ts (same key derivation)
function encryptInline(plaintext: string): string {
  const iv = randomBytes(16);
  const key = getDecryptKey();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Token refresh helper (inlined — worker cannot import from backend)
// ---------------------------------------------------------------------------
async function maybeRefreshHubSpotToken(tokens: {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  workspaceId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WorkspaceModel: mongoose.Model<any>;
}): Promise<string> {
  const fiveMinutes = 5 * 60 * 1000;
  if (tokens.expiresAt.getTime() - Date.now() > fiveMinutes) {
    return tokens.accessToken; // still fresh
  }

  const clientId = process.env['HUBSPOT_CLIENT_ID'];
  const clientSecret = process.env['HUBSPOT_CLIENT_SECRET'];
  if (!clientId || !clientSecret) {
    logger.warn('hubspot.worker: cannot refresh token — HUBSPOT_CLIENT_ID/SECRET not set');
    return tokens.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refreshToken,
  });

  const resp = await fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    logger.warn('hubspot.worker: token refresh failed, using existing token', { status: resp.status });
    return tokens.accessToken;
  }

  const data = await resp.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000);

  // Persist refreshed tokens back to workspace (encrypted inline)
  await tokens.WorkspaceModel.updateOne(
    { _id: tokens.workspaceId },
    {
      $set: {
        'crmConfig.hubspot.accessToken': encryptInline(data.access_token),
        'crmConfig.hubspot.refreshToken': encryptInline(data.refresh_token),
        'crmConfig.hubspot.expiresAt': newExpiresAt,
      },
    }
  );

  logger.info('hubspot.worker: token refreshed successfully', { workspaceId: tokens.workspaceId });
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Industry normalisation — HubSpot requires an exact enum key.
// Map common free-text values (lowercase) → HubSpot enum. Unrecognised
// values are dropped rather than rejected by the API.
// ---------------------------------------------------------------------------
const INDUSTRY_MAP: Record<string, string> = {
  accounting: 'ACCOUNTING',
  airlines: 'AIRLINES_AVIATION',
  'airlines & aviation': 'AIRLINES_AVIATION',
  'airlines_aviation': 'AIRLINES_AVIATION',
  aviation: 'AVIATION_AEROSPACE',
  aerospace: 'AVIATION_AEROSPACE',
  'aviation & aerospace': 'AVIATION_AEROSPACE',
  'aviation_aerospace': 'AVIATION_AEROSPACE',
  'alternative dispute resolution': 'ALTERNATIVE_DISPUTE_RESOLUTION',
  'alternative medicine': 'ALTERNATIVE_MEDICINE',
  animation: 'ANIMATION',
  apparel: 'APPAREL_FASHION',
  fashion: 'APPAREL_FASHION',
  'apparel & fashion': 'APPAREL_FASHION',
  architecture: 'ARCHITECTURE_PLANNING',
  planning: 'ARCHITECTURE_PLANNING',
  'arts and crafts': 'ARTS_AND_CRAFTS',
  automotive: 'AUTOMOTIVE',
  banking: 'BANKING',
  biotechnology: 'BIOTECHNOLOGY',
  'broadcast media': 'BROADCAST_MEDIA',
  'building materials': 'BUILDING_MATERIALS',
  'capital markets': 'CAPITAL_MARKETS',
  chemicals: 'CHEMICALS',
  'civic & social organization': 'CIVIC_SOCIAL_ORGANIZATION',
  'civil engineering': 'CIVIL_ENGINEERING',
  'commercial real estate': 'COMMERCIAL_REAL_ESTATE',
  'computer & network security': 'COMPUTER_NETWORK_SECURITY',
  'computer games': 'COMPUTER_GAMES',
  'computer hardware': 'COMPUTER_HARDWARE',
  'computer networking': 'COMPUTER_NETWORKING',
  'computer software': 'COMPUTER_SOFTWARE',
  software: 'COMPUTER_SOFTWARE',
  internet: 'INTERNET',
  construction: 'CONSTRUCTION',
  'consumer electronics': 'CONSUMER_ELECTRONICS',
  'consumer goods': 'CONSUMER_GOODS',
  'consumer services': 'CONSUMER_SERVICES',
  cosmetics: 'COSMETICS',
  dairy: 'DAIRY',
  'defense & space': 'DEFENSE_SPACE',
  design: 'DESIGN',
  'education management': 'EDUCATION_MANAGEMENT',
  education: 'EDUCATION_MANAGEMENT',
  'e-learning': 'E_LEARNING',
  elearning: 'E_LEARNING',
  'electrical & electronic manufacturing': 'ELECTRICAL_ELECTRONIC_MANUFACTURING',
  electronics: 'ELECTRICAL_ELECTRONIC_MANUFACTURING',
  entertainment: 'ENTERTAINMENT',
  'environmental services': 'ENVIRONMENTAL_SERVICES',
  'events services': 'EVENTS_SERVICES',
  events: 'EVENTS_SERVICES',
  'facilities services': 'FACILITIES_SERVICES',
  farming: 'FARMING',
  agriculture: 'FARMING',
  'financial services': 'FINANCIAL_SERVICES',
  finance: 'FINANCIAL_SERVICES',
  fintech: 'FINANCIAL_SERVICES',
  'fine art': 'FINE_ART',
  fishery: 'FISHERY',
  'food & beverages': 'FOOD_BEVERAGES',
  'food and beverage': 'FOOD_BEVERAGES',
  'food production': 'FOOD_PRODUCTION',
  fundraising: 'FUND_RAISING',
  furniture: 'FURNITURE',
  'gambling & casinos': 'GAMBLING_CASINOS',
  'government administration': 'GOVERNMENT_ADMINISTRATION',
  government: 'GOVERNMENT_ADMINISTRATION',
  'government relations': 'GOVERNMENT_RELATIONS',
  'graphic design': 'GRAPHIC_DESIGN',
  'health wellness and fitness': 'HEALTH_WELLNESS_AND_FITNESS',
  health: 'HEALTH_WELLNESS_AND_FITNESS',
  fitness: 'HEALTH_WELLNESS_AND_FITNESS',
  wellness: 'HEALTH_WELLNESS_AND_FITNESS',
  'higher education': 'HIGHER_EDUCATION',
  university: 'HIGHER_EDUCATION',
  'hospital & health care': 'HOSPITAL_HEALTH_CARE',
  healthcare: 'HOSPITAL_HEALTH_CARE',
  'health care': 'HOSPITAL_HEALTH_CARE',
  hospitality: 'HOSPITALITY',
  'human resources': 'HUMAN_RESOURCES',
  hr: 'HUMAN_RESOURCES',
  'import and export': 'IMPORT_AND_EXPORT',
  'industrial automation': 'INDUSTRIAL_AUTOMATION',
  'information services': 'INFORMATION_SERVICES',
  'information technology and services': 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  'information technology': 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  'it services': 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  it: 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  tech: 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  technology: 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  insurance: 'INSURANCE',
  'investment banking': 'INVESTMENT_BANKING',
  'investment management': 'INVESTMENT_MANAGEMENT',
  'law practice': 'LAW_PRACTICE',
  'legal services': 'LEGAL_SERVICES',
  legal: 'LEGAL_SERVICES',
  'leisure travel & tourism': 'LEISURE_TRAVEL_TOURISM',
  travel: 'LEISURE_TRAVEL_TOURISM',
  tourism: 'LEISURE_TRAVEL_TOURISM',
  'logistics and supply chain': 'LOGISTICS_AND_SUPPLY_CHAIN',
  logistics: 'LOGISTICS_AND_SUPPLY_CHAIN',
  'luxury goods & jewelry': 'LUXURY_GOODS_JEWELRY',
  luxury: 'LUXURY_GOODS_JEWELRY',
  machinery: 'MACHINERY',
  'management consulting': 'MANAGEMENT_CONSULTING',
  consulting: 'MANAGEMENT_CONSULTING',
  maritime: 'MARITIME',
  'market research': 'MARKET_RESEARCH',
  'marketing and advertising': 'MARKETING_AND_ADVERTISING',
  marketing: 'MARKETING_AND_ADVERTISING',
  advertising: 'MARKETING_AND_ADVERTISING',
  'mechanical or industrial engineering': 'MECHANICAL_OR_INDUSTRIAL_ENGINEERING',
  engineering: 'MECHANICAL_OR_INDUSTRIAL_ENGINEERING',
  'media production': 'MEDIA_PRODUCTION',
  media: 'MEDIA_PRODUCTION',
  'medical devices': 'MEDICAL_DEVICES',
  'medical practice': 'MEDICAL_PRACTICE',
  'mental health care': 'MENTAL_HEALTH_CARE',
  military: 'MILITARY',
  'mining & metals': 'MINING_METALS',
  mining: 'MINING_METALS',
  'motion pictures and film': 'MOTION_PICTURES_AND_FILM',
  film: 'MOTION_PICTURES_AND_FILM',
  music: 'MUSIC',
  nanotechnology: 'NANOTECHNOLOGY',
  newspapers: 'NEWSPAPERS',
  'non-profit': 'NON_PROFIT_ORGANIZATION_MANAGEMENT',
  nonprofit: 'NON_PROFIT_ORGANIZATION_MANAGEMENT',
  'oil & energy': 'OIL_ENERGY',
  oil: 'OIL_ENERGY',
  energy: 'OIL_ENERGY',
  'online media': 'ONLINE_MEDIA',
  'outsourcing/offshoring': 'OUTSOURCING_OFFSHORING',
  outsourcing: 'OUTSOURCING_OFFSHORING',
  pharmaceuticals: 'PHARMACEUTICALS',
  pharma: 'PHARMACEUTICALS',
  photography: 'PHOTOGRAPHY',
  'political organization': 'POLITICAL_ORGANIZATION',
  'primary/secondary education': 'PRIMARY_SECONDARY_EDUCATION',
  'primary secondary education': 'PRIMARY_SECONDARY_EDUCATION',
  printing: 'PRINTING',
  'professional training & coaching': 'PROFESSIONAL_TRAINING_COACHING',
  'public relations': 'PUBLIC_RELATIONS_AND_COMMUNICATIONS',
  pr: 'PUBLIC_RELATIONS_AND_COMMUNICATIONS',
  'public safety': 'PUBLIC_SAFETY',
  publishing: 'PUBLISHING',
  'real estate': 'REAL_ESTATE',
  'renewables & environment': 'RENEWABLES_ENVIRONMENT',
  renewables: 'RENEWABLES_ENVIRONMENT',
  research: 'RESEARCH',
  restaurants: 'RESTAURANTS',
  'food service': 'RESTAURANTS',
  retail: 'RETAIL',
  'security and investigations': 'SECURITY_AND_INVESTIGATIONS',
  security: 'SECURITY_AND_INVESTIGATIONS',
  semiconductors: 'SEMICONDUCTORS',
  'sporting goods': 'SPORTING_GOODS',
  sports: 'SPORTS',
  'staffing and recruiting': 'STAFFING_AND_RECRUITING',
  staffing: 'STAFFING_AND_RECRUITING',
  recruiting: 'STAFFING_AND_RECRUITING',
  telecommunications: 'TELECOMMUNICATIONS',
  telecom: 'TELECOMMUNICATIONS',
  textiles: 'TEXTILES',
  tobacco: 'TOBACCO',
  utilities: 'UTILITIES',
  'venture capital': 'VENTURE_CAPITAL_PRIVATE_EQUITY',
  'venture capital & private equity': 'VENTURE_CAPITAL_PRIVATE_EQUITY',
  'private equity': 'VENTURE_CAPITAL_PRIVATE_EQUITY',
  veterinary: 'VETERINARY',
  warehousing: 'WAREHOUSING',
  wholesale: 'WHOLESALE',
  'wine and spirits': 'WINE_AND_SPIRITS',
  wireless: 'WIRELESS',
  'writing and editing': 'WRITING_AND_EDITING',
  'mobile games': 'MOBILE_GAMES',
  gaming: 'COMPUTER_GAMES',
  'saas': 'COMPUTER_SOFTWARE',
  'e-commerce': 'INTERNET',
  ecommerce: 'INTERNET',
  'supply chain': 'LOGISTICS_AND_SUPPLY_CHAIN',
  transportation: 'TRANSPORTATION_TRUCKING_RAILROAD',
  trucking: 'TRANSPORTATION_TRUCKING_RAILROAD',
  railroad: 'TRANSPORTATION_TRUCKING_RAILROAD',
};

function normaliseIndustry(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toLowerCase();
  return INDUSTRY_MAP[key] ?? undefined;
}

// ---------------------------------------------------------------------------
// Inlined HubSpot API helpers (workers cannot import from backend)
// ---------------------------------------------------------------------------
async function hubspotRequest(
  accessToken: string,
  method: string,
  url: string,
  body?: unknown
): Promise<unknown> {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HubSpot API error ${resp.status} ${method} ${url}: ${text}`);
  }
  return resp.json();
}

async function upsertCompany(accessToken: string, company: {
  name: string;
  domain?: string;
  industry?: string;
  city?: string;
  country?: string;
  phone?: string;
}): Promise<{ id: string; status: 'created' | 'existing' }> {
  const properties: Record<string, string | undefined> = {
    name: company.name,
    domain: company.domain,
    industry: normaliseIndustry(company.industry),
    city: company.city,
    country: company.country,
    phone: company.phone,
  };
  // Remove undefined values — HubSpot rejects null/undefined properties
  for (const k of Object.keys(properties)) {
    if (properties[k] === undefined) delete properties[k];
  }

  // Search for existing company by domain (avoids needing domain as a unique prop)
  if (company.domain) {
    const searchResult = await hubspotRequest(
      accessToken,
      'POST',
      'https://api.hubapi.com/crm/v3/objects/companies/search',
      {
        filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: company.domain }] }],
        properties: ['domain', 'name'],
        limit: 1,
      }
    ) as { results: Array<{ id: string }> };

    if (searchResult.results.length > 0) {
      const id = searchResult.results[0]!.id;
      await hubspotRequest(accessToken, 'PATCH', `https://api.hubapi.com/crm/v3/objects/companies/${id}`, { properties });
      return { id, status: 'existing' };
    }
  }

  // Not found — create
  const created = await hubspotRequest(
    accessToken,
    'POST',
    'https://api.hubapi.com/crm/v3/objects/companies',
    { properties }
  ) as { id: string };
  return { id: created.id, status: 'created' };
}

async function upsertContact(accessToken: string, contact: {
  firstName?: string;
  lastName?: string;
  email?: string;
  jobTitle?: string;
  phone?: string;
}): Promise<{ id: string; status: 'created' | 'existing' }> {
  let input: Record<string, unknown>;
  if (contact.email) {
    input = {
      idProperty: 'email',
      id: contact.email,
      properties: {
        firstname: contact.firstName,
        lastname: contact.lastName,
        email: contact.email,
        jobtitle: contact.jobTitle,
        ...(contact.phone ? { phone: contact.phone } : {}),
      },
    };
  } else {
    input = {
      properties: {
        firstname: contact.firstName,
        lastname: contact.lastName,
        jobtitle: contact.jobTitle,
        ...(contact.phone ? { phone: contact.phone } : {}),
      },
    };
  }
  const result = await hubspotRequest(
    accessToken,
    'POST',
    'https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert',
    { inputs: [input] }
  ) as { results: Array<{ id: string; status: string }> };
  const first = result.results[0];
  if (!first) throw new Error('HubSpot returned empty results for contact upsert');
  return { id: first.id, status: first.status === 'CREATED' ? 'created' : 'existing' };
}

async function associateContactToCompany(
  accessToken: string,
  contactId: string,
  companyId: string
): Promise<void> {
  await hubspotRequest(
    accessToken,
    'POST',
    'https://api.hubapi.com/crm/v4/associations/contacts/companies/batch/create',
    {
      inputs: [
        {
          from: { id: contactId },
          to: { id: companyId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }],
        },
      ],
    }
  );
}

// ---------------------------------------------------------------------------
// Job payload
// ---------------------------------------------------------------------------
export interface HubSpotSyncPayload {
  workspaceId: string;
  direction: 'push' | 'pull' | 'full';
  leadIds?: string[];
  triggeredBy: 'manual' | 'auto_job_complete' | 'scheduled';
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------
async function processHubspotSync(job: Job<HubSpotSyncPayload>): Promise<void> {
  const { workspaceId, direction, leadIds } = job.data;
  logger.info('hubspot.worker: processing', { jobId: job.id, workspaceId, direction });

  if (direction === 'pull') {
    logger.info('hubspot.worker: pull not yet implemented', { workspaceId });
    return;
  }

  // 1. Load workspace with encrypted tokens
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workspace = await Workspace.findById(workspaceId)
    .select('+crmConfig.hubspot.accessToken +crmConfig.hubspot.refreshToken');

  if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

  const hs = workspace.crmConfig?.hubspot;
  if (!hs?.accessToken) throw new Error('HubSpot not connected for this workspace');

  // 2. Decrypt tokens
  const decryptedAccess = decrypt(hs.accessToken as string);
  const decryptedRefresh = hs.refreshToken ? decrypt(hs.refreshToken as string) : '';

  // 3. Refresh token if near expiry
  const accessToken = await maybeRefreshHubSpotToken({
    accessToken: decryptedAccess,
    refreshToken: decryptedRefresh,
    expiresAt: hs.expiresAt ? new Date(hs.expiresAt as string) : new Date(0),
    workspaceId,
    WorkspaceModel: Workspace,
  });

  // 4. Load leads
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let leads: any[];
  if (leadIds && leadIds.length > 0) {
    leads = await Lead.find({
      _id: { $in: leadIds.map((id) => new mongoose.Types.ObjectId(id)) },
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
    });
  } else {
    leads = await Lead.find({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      companyDomain: { $exists: true, $ne: '' },
    }).limit(200);
  }

  logger.info('hubspot.worker: syncing leads', { count: leads.length, workspaceId });

  let companiesSynced = 0;
  let contactsSynced = 0;
  let errors = 0;

  for (const lead of leads) {
    try {
      // 5. Upsert company
      const companyResult = await upsertCompany(accessToken, {
        name: lead.companyName,
        domain: lead.companyDomain,
        industry: lead.industry,
        city: lead.address?.city,
        country: lead.address?.country,
        phone: lead.phones?.[0]?.normalized,
      });
      companiesSynced++;

      // Store hubspot company ref on lead (best-effort)
      await Lead.updateOne(
        { _id: lead._id },
        {
          $set: {
            'crmRefs': [
              {
                provider: 'hubspot',
                externalId: companyResult.id,
                syncedAt: new Date(),
                syncStatus: 'synced',
              },
            ],
          },
        }
      );

      // 6. Load contacts for this lead
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contacts: any[] = await Contact.find({
        leadId: lead._id,
        isActive: true,
      });

      for (const contact of contacts) {
        try {
          const primaryEmail = (contact.emails?.[0]?.address) as string | undefined;

          // Skip contacts with no email and no name
          if (!contact.fullName && !primaryEmail) continue;

          const primaryPhone = (contact.phones?.[0]?.normalized) as string | undefined;

          const contactResult = await upsertContact(accessToken, {
            firstName: contact.firstName,
            lastName: contact.lastName,
            email: primaryEmail,
            jobTitle: contact.title,
            phone: primaryPhone,
          });
          contactsSynced++;

          // Associate contact to company
          await associateContactToCompany(accessToken, contactResult.id, companyResult.id);

          // Store crmRef on contact
          await Contact.updateOne(
            { _id: contact._id },
            {
              $set: {
                crmRefs: [
                  {
                    provider: 'hubspot',
                    externalId: contactResult.id,
                    syncedAt: new Date(),
                    syncStatus: 'synced',
                  },
                ],
              },
            }
          );
        } catch (contactErr) {
          errors++;
          logger.warn('hubspot.worker: contact upsert failed', {
            contactId: contact._id,
            err: contactErr instanceof Error ? contactErr.message : String(contactErr),
          });
        }
      }
    } catch (leadErr) {
      errors++;
      logger.warn('hubspot.worker: lead upsert failed', {
        leadId: lead._id,
        err: leadErr instanceof Error ? leadErr.message : String(leadErr),
      });
    }
  }

  // 7. Write sync log entry
  await Workspace.updateOne(
    { _id: workspaceId },
    {
      $set: { 'crmConfig.hubspot.lastSyncAt': new Date() },
      $push: {
        'crmConfig.hubspot.syncLog': {
          $each: [{ syncedAt: new Date(), direction, companiesSynced, contactsSynced, errors }],
          $slice: -50,
        },
      },
    }
  );

  logger.info('hubspot.worker: sync complete', { workspaceId, companiesSynced, contactsSynced, errors });
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------
export function createHubspotWorker(connection: Redis): Worker {
  if (mongoose.connection.readyState === 0) {
    mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME }).catch((err) =>
      logger.error('hubspot.worker: Mongo connect error', { err })
    );
  }

  const worker = new Worker<HubSpotSyncPayload>(
    'hubspot-sync',
    async (job: Job<HubSpotSyncPayload>) => {
      await processHubspotSync(job);
    },
    {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
      prefix: `{bull}:leadreai:${env.NODE_ENV}`,
    }
  );

  worker.on('completed', (job) => logger.info('hubspot.worker: job completed', { jobId: job.id }));
  worker.on('failed', (job, err) =>
    logger.error('hubspot.worker: job failed', { jobId: job?.id, err })
  );

  return worker;
}
