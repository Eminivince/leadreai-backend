import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';

export interface RegistryOfficer {
  name: string;
  position?: string;
  startDate?: string;
  endDate?: string;
}

export interface RegistryCompany {
  name: string;
  companyNumber: string;
  jurisdictionCode: string;
  registeredAddress?: string;
  incorporationDate?: string;
  companyType?: string;
  status?: string;
  officers: RegistryOfficer[];
  openCorporatesUrl?: string;
}

const BASE = 'https://api.opencorporates.com/v0.4';
const TIMEOUT_MS = 10_000;

const COUNTRY_TO_JURISDICTION: Record<string, string> = {
  nigeria: 'ng',
  'united kingdom': 'gb',
  uk: 'gb',
  britain: 'gb',
  'united states': 'us',
  usa: 'us',
  us: 'us',
  canada: 'ca',
  australia: 'au',
  india: 'in',
  germany: 'de',
  france: 'fr',
  spain: 'es',
  italy: 'it',
  'south africa': 'za',
  kenya: 'ke',
  ghana: 'gh',
  singapore: 'sg',
  'hong kong': 'hk',
};

function jurisdictionFromCountry(country?: string): string | undefined {
  if (!country) return undefined;
  return COUNTRY_TO_JURISDICTION[country.toLowerCase().trim()];
}

function withApiKey(params: URLSearchParams): URLSearchParams {
  if (env.OPENCORPORATES_API_KEY) params.set('api_token', env.OPENCORPORATES_API_KEY);
  return params;
}

async function httpJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      logger.debug('[opencorporates] non-200', { url, status: res.status });
      return null;
    }
    return await res.json() as T;
  } catch (err) {
    logger.debug('[opencorporates] request failed', { url, err: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeCompany(raw: any): RegistryCompany | null {
  const c = raw?.company;
  if (!c?.name || !c?.company_number || !c?.jurisdiction_code) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const officers: RegistryOfficer[] = (c.officers ?? []).map((o: any) => ({
    name: o?.officer?.name ?? '',
    position: o?.officer?.position,
    startDate: o?.officer?.start_date,
    endDate: o?.officer?.end_date,
  })).filter((o: RegistryOfficer) => o.name);

  return {
    name: c.name,
    companyNumber: c.company_number,
    jurisdictionCode: c.jurisdiction_code,
    registeredAddress: c.registered_address_in_full,
    incorporationDate: c.incorporation_date,
    companyType: c.company_type,
    status: c.current_status,
    officers,
    openCorporatesUrl: c.opencorporates_url,
  };
}

export async function searchCompany(
  name: string,
  country?: string,
  limit = 3,
): Promise<RegistryCompany[]> {
  const params = withApiKey(new URLSearchParams({ q: name, per_page: String(limit) }));
  const juris = jurisdictionFromCountry(country);
  if (juris) params.set('jurisdiction_code', juris);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await httpJson<any>(`${BASE}/companies/search?${params.toString()}`);
  if (!data?.results?.companies) return [];

  const companies: RegistryCompany[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const entry of data.results.companies as any[]) {
    const norm = normalizeCompany(entry);
    if (norm) companies.push(norm);
    if (companies.length >= limit) break;
  }
  return companies;
}

export async function fetchCompanyDetails(
  jurisdictionCode: string,
  companyNumber: string,
): Promise<RegistryCompany | null> {
  const params = withApiKey(new URLSearchParams());
  const qs = params.toString();
  const url = `${BASE}/companies/${jurisdictionCode}/${encodeURIComponent(companyNumber)}${qs ? `?${qs}` : ''}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await httpJson<any>(url);
  if (!data?.results) return null;
  return normalizeCompany(data.results);
}

export async function enrichEntity(
  name: string,
  country?: string,
): Promise<RegistryCompany | null> {
  const matches = await searchCompany(name, country, 3);
  if (matches.length === 0) {
    logger.debug('[opencorporates] no matches', { name, country });
    return null;
  }
  const top = matches[0]!;
  if (top.officers.length > 0) return top;
  const detailed = await fetchCompanyDetails(top.jurisdictionCode, top.companyNumber);
  return detailed ?? top;
}
