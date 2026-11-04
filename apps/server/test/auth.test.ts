import { describe, expect, it } from 'vitest';
import {
  createSession,
  createStreamTicket,
  createUser,
  deleteAllSessions,
  deleteSession,
  hashPassword,
  loginLockedFor,
  purgeExpiredAuth,
  recordLoginFailure,
  recordLoginSuccess,
  redeemStreamTicket,
  userFromToken,
  verifyPassword,
} from '../src/auth.js';
import { one } from '../src/db.js';
import { run } from '../src/db.js';

describe('passwords', () => {
  it('hash/verify round-trips with a random salt', () => {
    const h = hashPassword('correct horse');
    expect(h).toMatch(/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(hashPassword('correct horse')).not.toBe(h);
    expect(verifyPassword('correct horse', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });
  it('rejects missing or malformed hashes', () => {
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('sessions', () => {
  it('resolves valid tokens, rejects expired and deleted ones', async () => {
    const user = await createUser(`a${Date.now()}@x.io`, 'A', 'password1');
    const token = await createSession(user.id);
    expect((await userFromToken(token))?.id).toBe(user.id);
    expect(await userFromToken(undefined)).toBeUndefined();
    expect(await userFromToken('nope')).toBeUndefined();

    await run('UPDATE sessions SET expires_at = ? WHERE token = ?', new Date(Date.now() - 1000).toISOString(), token);
    expect(await userFromToken(token)).toBeUndefined();

    const t2 = await createSession(user.id);
    await deleteSession(t2);
    expect(await userFromToken(t2)).toBeUndefined();
  });
});

describe('stream tickets', () => {
  it('are single-use and expire', async () => {
    const user = await createUser(`t${Date.now()}@x.io`, 'T', 'password1');
    const t = await createStreamTicket(user.id);
    expect((await redeemStreamTicket(t))?.id).toBe(user.id);
    expect(await redeemStreamTicket(t)).toBeUndefined();
    expect(await redeemStreamTicket(undefined)).toBeUndefined();

    const t2 = await createStreamTicket(user.id);
    await run('UPDATE stream_tickets SET expires_at = ? WHERE ticket = ?', new Date(Date.now() - 1).toISOString(), t2);
    expect(await redeemStreamTicket(t2)).toBeUndefined();
  });
});

describe('session hygiene', () => {
  it('purges expired rows and signs out everywhere', async () => {
    const user = await createUser(`h${Date.now()}@x.io`, 'H', 'password1');
    const live = await createSession(user.id);
    const old = await createSession(user.id);
    await run('UPDATE sessions SET expires_at = ? WHERE token = ?', '2000-01-01T00:00:00.000Z', old);
    await purgeExpiredAuth();
    expect(await one('SELECT 1 FROM sessions WHERE token = ?', old)).toBeUndefined();
    expect((await userFromToken(live))?.id).toBe(user.id);
    await createSession(user.id);
    await deleteAllSessions(user.id);
    expect((await one<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE user_id = ?', user.id))?.n).toBe(0);
  });
});

describe('login lockout', () => {
  it('locks an account after 5 failures for 15 minutes', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) recordLoginFailure('l@x.io', t0);
    expect(loginLockedFor('l@x.io', t0)).toBe(0);
    recordLoginFailure('l@x.io', t0);
    expect(loginLockedFor('l@x.io', t0)).toBe(900);
    expect(loginLockedFor('l@x.io', t0 + 15 * 60_000)).toBe(0);
    recordLoginSuccess('l@x.io');
    expect(loginLockedFor('l@x.io', t0)).toBe(0);
  });
});
