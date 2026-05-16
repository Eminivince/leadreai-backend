// Reserved for use by CRM controller future operations. Token refresh during sync is inlined in workers/src/hubspot.worker.ts.
import { env } from '../../config/env.js';

export interface HubSpotTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

// Returns refreshed tokens if within 5 minutes of expiry, otherwise returns same tokens
export async function maybeRefreshToken(current: HubSpotTokens): Promise<HubSpotTokens> {
  const fiveMinutes = 5 * 60 * 1000;
  if (current.expiresAt.getTime() - Date.now() > fiveMinutes) {
    return current; // still fresh
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.HUBSPOT_CLIENT_ID ?? '',
    client_secret: env.HUBSPOT_CLIENT_SECRET ?? '',
    refresh_token: current.refreshToken,
  });

  const resp = await fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`HubSpot token refresh failed: ${resp.status}`);
  }

  const data = await resp.json() as { access_token: string; refresh_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}
