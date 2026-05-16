import { describe, it, expect, beforeAll, vi, beforeEach, afterEach } from 'vitest';

beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
  process.env['JWT_SECRET'] = 'a'.repeat(32);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(32);
  process.env['MONGODB_URI'] = 'mongodb://localhost:27017/test';
  process.env['MONGODB_DB_NAME'] = 'leadreai_test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['UNSUBSCRIBE_TOKEN_SECRET'] = 'c'.repeat(16);
  process.env['ENCRYPTION_KEY'] = 'd'.repeat(32);
  process.env['GOOGLE_OAUTH_CLIENT_ID'] = 'fake-client';
  process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'fake-secret';
});

/**
 * Email preflight unit tests. The decrypt() helper is the moving part —
 * we mock it to be a passthrough so we don't have to seed valid ciphertext
 * for the test. The fetch calls are mocked so we never hit live APIs.
 *
 * What we verify:
 *   - missing-fromEmail blocks all providers
 *   - missing-credentials blocks per-provider correctly
 *   - 401 from Resend / SendGrid surfaces in result.reason
 *   - Gmail refresh-token failure surfaces a reconnect-required reason
 *   - Unknown provider returns ok:false with a clear reason
 */

describe('preflightEmailProvider', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../utils/encrypt.js', () => ({
      decrypt: (s: string) => s, // identity for tests
      encrypt: (s: string) => s,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses when fromEmail is missing', async () => {
    const { preflightEmailProvider } = await import('./preflight.js');
    const result = await preflightEmailProvider({ provider: 'resend' } as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('fromEmail');
  });

  it('refuses Resend without an API key', async () => {
    const { preflightEmailProvider } = await import('./preflight.js');
    const result = await preflightEmailProvider({ provider: 'resend', fromEmail: 'a@b.com' } as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Resend API key');
  });

  it('surfaces Resend rejection status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response));
    const { preflightEmailProvider } = await import('./preflight.js');
    const result = await preflightEmailProvider({
      provider: 'resend',
      fromEmail: 'a@b.com',
      apiKey: 're_fakekey',
    } as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('401');
  });

  it('passes Resend when fetch returns ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response));
    const { preflightEmailProvider } = await import('./preflight.js');
    const result = await preflightEmailProvider({
      provider: 'resend',
      fromEmail: 'a@b.com',
      apiKey: 're_fakekey',
    } as never);
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('resend');
  });

  it('refuses Gmail when refresh token is missing', async () => {
    const { preflightEmailProvider } = await import('./preflight.js');
    const result = await preflightEmailProvider({
      provider: 'gmail',
      fromEmail: 'a@b.com',
      gmail: {},
    } as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/refresh/i);
  });

  it('surfaces Gmail refresh failure as reconnect-required', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400 }) as unknown as Response));
    const { preflightEmailProvider } = await import('./preflight.js');
    const result = await preflightEmailProvider({
      provider: 'gmail',
      fromEmail: 'a@b.com',
      gmail: { refreshToken: 'tok' },
    } as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/reconnect/i);
  });

  it('returns ok for valid Gmail refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response));
    const { preflightEmailProvider } = await import('./preflight.js');
    const result = await preflightEmailProvider({
      provider: 'gmail',
      fromEmail: 'a@b.com',
      gmail: { refreshToken: 'tok', email: 'sender@ws.com' },
    } as never);
    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({ email: 'sender@ws.com' });
  });

  it('flags unsupported providers', async () => {
    const { preflightEmailProvider } = await import('./preflight.js');
    const result = await preflightEmailProvider({
      provider: 'mailchimp' as never,
      fromEmail: 'a@b.com',
    } as never);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unsupported/i);
  });
});
