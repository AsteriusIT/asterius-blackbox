import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { newId, one, run, type UserRow } from './db.js';

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

export function createUser(email: string, name: string, password: string) {
  const id = newId();
  run("INSERT INTO users (id, provider, email, name, password_hash) VALUES (?, 'local', ?, ?, ?)", id, email.toLowerCase(), name, hashPassword(password));
  return one<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
}

export function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires);
  return token;
}

export function userFromToken(token: string | undefined): UserRow | undefined {
  if (!token) return undefined;
  return one<UserRow>(
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

/** Bearer token, or `?token=` for EventSource which cannot set headers. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query as { token?: string })?.token;
  const user = userFromToken(token);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  req.user = user;
}

export function deleteSession(token: string) {
  run('DELETE FROM sessions WHERE token = ?', token);
}

export const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.name, provider: u.provider });
