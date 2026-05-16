import { promises as dns } from 'dns';
import * as net from 'net';
import { logger } from '../utils/logger.js';

export interface DetectedEmail {
  address: string;
  type: 'business' | 'generic' | 'personal' | 'pattern_inferred';
  confidence: number;
  source: string;
}

const GENERIC_PREFIXES = [
  'info', 'contact', 'hello', 'admin', 'support', 'enquiries', 'enquiry',
  'sales', 'office', 'mail', 'team', 'help', 'service', 'services',
];

const NOISE_PREFIXES = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'bounce', 'bounces', 'mailer-daemon', 'maildaemon',
  'newsletter', 'newsletters', 'unsubscribe',
  'privacy', 'legal', 'compliance', 'dpo',
  'billing', 'invoice', 'invoices', 'accounts', 'accounting',
  'hr', 'careers', 'jobs', 'recruitment', 'hiring',
  'marketing', 'notifications', 'notify', 'alerts',
  'webmaster', 'postmaster', 'abuse', 'spam',
  'security', 'cert', 'soc',
];

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export async function detectEmails(
  domain: string,
  rawEmails: string[],
  hasMx: boolean,
  names?: string[],
): Promise<DetectedEmail[]> {
  const results: DetectedEmail[] = [];
  const seen = new Set<string>();

  // 1. Classify raw scraped emails
  for (const raw of rawEmails) {
    const addr = raw.toLowerCase().trim();
    if (!EMAIL_REGEX.test(addr) || seen.has(addr)) continue;
    seen.add(addr);
    const prefix = addr.split('@')[0] ?? '';
    // Reject noise addresses outright — they are never useful contacts
    if (NOISE_PREFIXES.some(p => prefix === p || prefix.startsWith(p + '-') || prefix.startsWith(p + '.'))) continue;
    const isGeneric = GENERIC_PREFIXES.some(p => prefix === p || prefix.startsWith(p));
    results.push({
      address: addr,
      type: isGeneric ? 'generic' : 'business',
      confidence: isGeneric ? 0.6 : 0.95,
      source: 'scraped',
    });
  }

  if (!hasMx) return results;

  // 2. Generate pattern emails for the domain
  const patterns = [
    `info@${domain}`, `contact@${domain}`, `hello@${domain}`,
    `admin@${domain}`, `sales@${domain}`, `office@${domain}`,
  ];

  // If we have names, add name patterns
  for (const name of (names ?? []).slice(0, 3)) {
    const parts = name.toLowerCase().split(/\s+/);
    const first = parts[0];
    const last = parts[1];
    if (first && last) {
      patterns.push(`${first}@${domain}`, `${first}.${last}@${domain}`, `${first[0]}${last}@${domain}`);
    }
  }

  // 3. Validate patterns via MX then SMTP
  for (const addr of patterns) {
    if (seen.has(addr)) continue;
    seen.add(addr);
    const confidence = await validateEmail(addr, domain);
    if (confidence > 0) {
      results.push({ address: addr, type: 'pattern_inferred', confidence, source: 'pattern' });
    }
  }

  logger.info('emailDetector: detection complete', { domain, count: results.length });
  return results;
}

async function validateEmail(email: string, domain: string): Promise<number> {
  try {
    const mxRecords = await dns.resolveMx(domain).catch(() => []);
    if (mxRecords.length === 0) return 0;

    const mx = mxRecords.sort((a, b) => a.priority - b.priority)[0]?.exchange;
    if (!mx) return 0.5;

    const valid = await smtpProbe(mx, email);
    return valid ? 0.80 : 0;
  } catch {
    return 0;
  }
}

async function smtpProbe(mx: string, email: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: mx, port: 25, timeout: 8000 });
    let step = 0;
    let buffer = '';

    const send = (cmd: string) => socket.write(cmd + '\r\n');

    socket.on('data', (data: Buffer) => {
      buffer += data.toString();
      if (!buffer.includes('\n')) return;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const code = parseInt(line.slice(0, 3));
        if (step === 0 && code === 220) { step++; send('EHLO leadreai.app'); }
        else if (step === 1 && code === 250) { step++; send('MAIL FROM:<check@leadreai.app>'); }
        else if (step === 2 && code === 250) { step++; send(`RCPT TO:<${email}>`); }
        else if (step === 3) {
          socket.destroy();
          resolve(code === 250 || code === 251);
        }
        else if (code >= 400) { socket.destroy(); resolve(false); }
      }
    });

    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}
