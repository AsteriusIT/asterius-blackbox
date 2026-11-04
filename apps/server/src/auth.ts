import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { newId, one, run, type UserRow } from './db.js';
import { config } from './config.js';
import type { PublicUser } from '@blackbox/shared';

const SESSION_DAYS = 14;

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [, saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export async function createUser(email: string, name: string, password: string) {
  const id = newId();
  await run("INSERT INTO users (id, provider, email, name, password_hash) VALUES (?, 'local', ?, ?, ?)", id, email.toLowerCase(), name, hashPassword(password));
  return (await one<UserRow>('SELECT * FROM users WHERE id = ?', id))!;
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires);
  return token;
}

export async function userFromToken(token: string | undefined): Promise<UserRow | undefined> {
  if (!token) return undefined;
  return await one<UserRow>(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
    token,
    new Date().toISOString(),
  );
}

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow;
  }
}

export const bearer = (req: FastifyRequest) => {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
};

/** Bearer token only: session tokens never travel in URLs (logs, proxies, history). */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const user = await userFromToken(bearer(req));
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  req.user = user;
}

export async function deleteSession(token: string) {
  await run('DELETE FROM sessions WHERE token = ?', token);
}

/** Platform admins (ADMIN_EMAILS): global audit log and cost views. */
export const isAdmin = (u: Pick<UserRow, 'email'>) => config.ADMIN_EMAILS.includes(u.email.toLowerCase());

export const publicUser = (u: UserRow): PublicUser => ({ id: u.id, email: u.email, name: u.name, provider: u.provider, admin: isAdmin(u) });

const TICKET_TTL_MS = 30_000;

/** EventSource cannot set headers: it authenticates with a short-lived, single-use ticket instead of the session token. */
export async function createStreamTicket(userId: string) {
  const ticket = randomBytes(24).toString('base64url');
  await run('DELETE FROM stream_tickets WHERE expires_at < ?', new Date().toISOString());
  await run('INSERT INTO stream_tickets (ticket, user_id, expires_at) VALUES (?, ?, ?)', ticket, userId, new Date(Date.now() + TICKET_TTL_MS).toISOString());
  return ticket;
}

export async function redeemStreamTicket(ticket: string | undefined): Promise<UserRow | undefined> {
  if (!ticket) return undefined;
  const row = await one<{ user_id: string; expires_at: string }>('SELECT user_id, expires_at FROM stream_tickets WHERE ticket = ?', ticket);
  await run('DELETE FROM stream_tickets WHERE ticket = ?', ticket);
  if (!row || row.expires_at < new Date().toISOString()) return undefined;
  return await one<UserRow>('SELECT * FROM users WHERE id = ?', row.user_id);
}

/** Hourly: drop expired sessions, OAuth states and stream tickets. */
export async function purgeExpiredAuth() {
  const now = new Date().toISOString();
  await run('DELETE FROM sessions WHERE expires_at < ?', now);
  await run('DELETE FROM oauth_states WHERE expires_at < ?', now);
  await run('DELETE FROM stream_tickets WHERE expires_at < ?', now);
}

export async function deleteAllSessions(userId: string) {
  await run('DELETE FROM sessions WHERE user_id = ?', userId);
}

// ---- brute-force protection: per-account lockout after repeated failed logins (in-memory, per instance)
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const failures = new Map<string, { count: number; lockedUntil: number }>();

export function loginLockedFor(email: string, now = Date.now()): number {
  const f = failures.get(email);
  return f && f.lockedUntil > now ? Math.ceil((f.lockedUntil - now) / 1000) : 0;
}
export function recordLoginFailure(email: string, now = Date.now()) {
  const f = failures.get(email) ?? { count: 0, lockedUntil: 0 };
  if (f.lockedUntil && f.lockedUntil <= now) f.count = 0;
  f.count++;
  f.lockedUntil = f.count >= MAX_FAILURES ? now + LOCK_MS : 0;
  failures.set(email, f);
}
export function recordLoginSuccess(email: string) {
  failures.delete(email);
}
