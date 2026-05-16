import { describe, it, expect, beforeAll } from 'vitest';

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
 * Auth-related invariants that don't need a live DB.
 *
 * The Sprint 2 logout-invalidation mechanism is most easily tested at
 * the integration level (real Mongo, real bcrypt). Here we test the
 * pure pieces: JWT tv comparison semantics + the bcrypt round-trip.
 */
describe('auth — JWT tokenVersion comparison', () => {
  it('treats a fresh token (tv=0) and tokenVersion=0 as a match', async () => {
    const { signAccessToken, verifyAccessToken } = await import('../lib/jwt.js');
    const token = signAccessToken({ sub: 'u1', email: 'a@b.com', tv: 0 });
    const decoded = verifyAccessToken(token);
    // Match condition used by authenticate middleware:
    expect((decoded.tv ?? 0) === 0).toBe(true);
  });

  it('treats missing tv claim as tv=0 (backward compatibility)', async () => {
    // Hand-craft a payload without `tv` to simulate a token minted before
    // the Sprint 2 change. Authenticate middleware uses `payload.tv ?? 0`
    // so these should NOT be rejected if the user's tokenVersion is 0.
    const jwt = (await import('jsonwebtoken')).default;
    const oldToken = jwt.sign({ sub: 'u1', email: 'a@b.com' }, 'a'.repeat(32), { expiresIn: '15m' });
    const { verifyAccessToken } = await import('../lib/jwt.js');
    const decoded = verifyAccessToken(oldToken);
    expect(decoded.tv).toBeUndefined();
    expect(decoded.tv ?? 0).toBe(0);
  });

  it('rejects a stale-version token via the comparison the middleware uses', async () => {
    const { signAccessToken, verifyAccessToken } = await import('../lib/jwt.js');
    // Token issued when user.tokenVersion was 3; user has since logged
    // out, bumping to 4. The middleware does `payload.tv !== user.tv`.
    const token = signAccessToken({ sub: 'u1', email: 'a@b.com', tv: 3 });
    const decoded = verifyAccessToken(token);
    const userCurrentTokenVersion = 4;
    expect(decoded.tv !== userCurrentTokenVersion).toBe(true);
  });
});

describe('auth — bcrypt round-trip', () => {
  it('hash + compare survives a real round-trip at production cost', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    // Use cost 10 in tests so the suite stays fast — production env
    // schema constrains to >= 10 anyway.
    const hash = await bcrypt.hash('correcthorsebatterystaple', 10);
    expect(await bcrypt.compare('correcthorsebatterystaple', hash)).toBe(true);
    expect(await bcrypt.compare('wrong-password', hash)).toBe(false);
  });

  it('hashing the same password twice produces different hashes (random salt)', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const h1 = await bcrypt.hash('hunter2', 10);
    const h2 = await bcrypt.hash('hunter2', 10);
    expect(h1).not.toBe(h2);
    // Both should still verify
    expect(await bcrypt.compare('hunter2', h1)).toBe(true);
    expect(await bcrypt.compare('hunter2', h2)).toBe(true);
  });
});
