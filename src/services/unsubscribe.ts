import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

interface UnsubscribePayload {
  wid: string;
  email: string;
}

export function signUnsubscribeToken(workspaceId: string, email: string): string {
  const secret = env.UNSUBSCRIBE_TOKEN_SECRET ?? env.JWT_SECRET;
  return jwt.sign(
    { wid: workspaceId, email: email.toLowerCase() },
    secret,
    { expiresIn: '30d' },
  );
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload {
  const secret = env.UNSUBSCRIBE_TOKEN_SECRET ?? env.JWT_SECRET;
  const payload = jwt.verify(token, secret) as UnsubscribePayload;
  if (!payload.wid || !payload.email) throw new Error('Invalid unsubscribe token');
  return payload;
}

export function buildUnsubscribeUrl(workspaceId: string, email: string): string {
  const token = signUnsubscribeToken(workspaceId, email);
  return `${env.UNSUBSCRIBE_BASE_URL}?t=${token}`;
}
