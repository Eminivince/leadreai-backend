import { promises as dns } from 'dns';
import * as tls from 'tls';
import { logger } from '../utils/logger.js';

export interface OsintData {
  whois?: {
    registrar?: string;
    registeredAt?: string;
    expiresAt?: string;
    registrantOrg?: string;
    registrantEmail?: string;
    nameservers?: string[];
  };
  dns?: {
    aRecords?: string[];
    mxRecords?: string[];
    txtRecords?: string[];
  };
  ssl?: {
    issuer?: string;
    validFrom?: string;
    validTo?: string;
    altNames?: string[];
  };
  techStack?: string[];
  hasMx?: boolean;
}

const EMAIL_FROM_WHOIS = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;

export async function enrichDomain(domain: string): Promise<OsintData> {
  logger.info('osintEnricher: enriching domain', { domain });

  const [whoisData, dnsData, sslData] = await Promise.allSettled([
    getWhois(domain),
    getDns(domain),
    getSsl(domain),
  ]);

  return {
    whois: whoisData.status === 'fulfilled' ? whoisData.value : undefined,
    dns: dnsData.status === 'fulfilled' ? dnsData.value : undefined,
    ssl: sslData.status === 'fulfilled' ? sslData.value : undefined,
    hasMx: dnsData.status === 'fulfilled' && dnsData.value != null
      ? (dnsData.value.mxRecords?.length ?? 0) > 0
      : false,
  };
}

async function getWhois(domain: string): Promise<OsintData['whois']> {
  const whois = await import('whois');
  const raw: string = await new Promise((resolve, reject) => {
    whois.lookup(domain, (err, data) => {
      if (err) reject(err);
      else resolve(typeof data === 'string' ? data : JSON.stringify(data));
    });
  });

  const get = (pattern: RegExp): string | undefined => pattern.exec(raw)?.[1]?.trim();
  return {
    registrar: get(/Registrar:\s*(.+)/i),
    registeredAt: get(/Creation Date:\s*(.+)/i) ?? get(/Registered On:\s*(.+)/i),
    expiresAt: get(/Expir\w+ Date:\s*(.+)/i),
    registrantOrg: get(/Registrant Org(?:anization)?:\s*(.+)/i),
    registrantEmail: raw.match(EMAIL_FROM_WHOIS)?.[0],
    nameservers: raw.match(/Name Server:\s*(.+)/gi)?.map(ns => ns.replace(/Name Server:\s*/i, '').trim()),
  };
}

async function getDns(domain: string): Promise<OsintData['dns']> {
  const [aRecords, mxRecords, txtRecords] = await Promise.allSettled([
    dns.resolve4(domain),
    dns.resolveMx(domain).then(recs => recs.map(r => r.exchange)),
    dns.resolveTxt(domain).then(recs => recs.map(r => r.join(''))),
  ]);
  return {
    aRecords: aRecords.status === 'fulfilled' ? aRecords.value : [],
    mxRecords: mxRecords.status === 'fulfilled' ? mxRecords.value : [],
    txtRecords: txtRecords.status === 'fulfilled' ? txtRecords.value.slice(0, 10) : [],
  };
}

async function getSsl(domain: string): Promise<OsintData['ssl']> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: domain, port: 443, servername: domain, timeout: 5000 }, () => {
      const cert = socket.getPeerCertificate(true);
      socket.destroy();
      resolve({
        issuer: (Array.isArray(cert.issuer?.O) ? cert.issuer.O[0] : cert.issuer?.O)
          ?? (Array.isArray(cert.issuer?.CN) ? cert.issuer.CN[0] : cert.issuer?.CN),
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        altNames: cert.subjectaltname
          ? cert.subjectaltname.split(', ').map(s => s.replace(/^DNS:/, ''))
          : [],
      });
    });
    socket.on('error', () => resolve({}));
    socket.on('timeout', () => { socket.destroy(); resolve({}); });
  });
}
