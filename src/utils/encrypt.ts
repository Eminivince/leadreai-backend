import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';

// Per-scope salts. Using a different salt per use-case means a key derived
// for (say) email creds can never decrypt a data-source credential — blast
// radius of a key leak stays bounded to its own scope.
const SALT_BY_SCOPE: Record<string, string> = {
  email: 'leadreai-email-salt',            // legacy name, kept for back-compat
  dataSource: 'leadreai-datasource-salt',   // Phase 15A
};

function getKey(scope: keyof typeof SALT_BY_SCOPE): Buffer {
  return scryptSync(env.JWT_SECRET, SALT_BY_SCOPE[scope]!, 32);
}

// ── Scoped API (preferred) ──────────────────────────────────────────

export function encryptScoped(plaintext: string, scope: keyof typeof SALT_BY_SCOPE): string {
  const iv = randomBytes(16);
  const key = getKey(scope);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptScoped(ciphertext: string, scope: keyof typeof SALT_BY_SCOPE): string {
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
  if (!ivHex || !authTagHex || !encryptedHex) throw new Error('Invalid ciphertext format');
  const key = getKey(scope);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return decipher.update(Buffer.from(encryptedHex, 'hex')) + decipher.final('utf8');
}

// ── Legacy API — retained for workspace.emailConfig back-compat ─────
export function encrypt(plaintext: string): string {
  return encryptScoped(plaintext, 'email');
}

export function decrypt(ciphertext: string): string {
  return decryptScoped(ciphertext, 'email');
}
