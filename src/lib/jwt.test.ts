import { describe, it, expect, beforeAll } from 'vitest';

// Seed all env vars the schema requires before importing any module that
// touches `env.ts`. The `jwt` module reads JWT_* secrets at load time, and
// env.ts process.exit(1)s on validation failure — so any missing var will
// kill the test process.
beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
  process.env['JWT_SECRET'] = 'a'.repeat(32);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(32);
  process.env['JWT_ACCESS_EXPIRES_IN'] = '15m';
  process.env['JWT_REFRESH_EXPIRES_IN'] = '30d';
  process.env['MONGODB_URI'] = 'mongodb://localhost:27017/test';
  process.env['MONGODB_DB_NAME'] = 'leadreai_test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['UNSUBSCRIBE_TOKEN_SECRET'] = 'c'.repeat(16);
});

/**
 * JWT token-version round-trip — the core of the logout-invalidation
 * mechanism added in Sprint 2. Every token MUST carry `tv` so the
 * authenticate middleware can compare it against User.tokenVersion and
 * reject stale-version tokens.
 */
describe('jwt — token version (tv) claim', () => {
  it('round-trips tv on access tokens', async () => {
    const { signAccessToken, verifyAccessToken } = await import('./jwt.js');
    const token = signAccessToken({ sub: 'u1', email: 'a@b.com', tv: 7 });
    const decoded = verifyAccessToken(token);
    expect(decoded.sub).toBe('u1');
    expect(decoded.email).toBe('a@b.com');
    expect(decoded.tv).toBe(7);
  });

  it('round-trips tv on refresh tokens', async () => {
    const { signRefreshToken, verifyRefreshToken } = await import('./jwt.js');
    const token = signRefreshToken('u1', 42);
    const decoded = verifyRefreshToken(token);
    expect(decoded.sub).toBe('u1');
    expect(decoded.tv).toBe(42);
  });

  it('rejects tokens with malformed payload', async () => {
    const { verifyAccessToken } = await import('./jwt.js');
    expect(() => verifyAccessToken('not-a-jwt')).toThrow();
  });

  it('rejects access tokens signed with the wrong secret', async () => {
    const { verifyAccessToken } = await import('./jwt.js');
    const jwt = (await import('jsonwebtoken')).default;
    const evil = jwt.sign({ sub: 'u1', email: 'a@b.com', tv: 0 }, 'wrong-secret-not-32-chars-long-but-long-enough');
    expect(() => verifyAccessToken(evil)).toThrow();
  });
});
