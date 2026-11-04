import { all, one, type AppRow, type UserRow } from './db.js';

/**
 * Shared applications. Access = owner, or a member: a user (`user:<id>`) or an Entra group (`group:<object id>`,
 * matched against the `groups` claim stored at sign-in). Roles: viewer (read) < editor (chat, stop, previews) < owner
 * (members, archive, delete).
 */
export type Role = 'viewer' | 'editor' | 'owner';
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export const userGroups = (u: Pick<UserRow, 'groups'>): string[] => {
  try {
    return u.groups ? (JSON.parse(u.groups) as string[]) : [];
  } catch {
    return [];
  }
};
const subjects = (u: Pick<UserRow, 'id' | 'groups'>) => [`user:${u.id}`, ...userGroups(u).map((g) => `group:${g}`)];

export async function roleOn(u: Pick<UserRow, 'id' | 'groups'>, app: Pick<AppRow, 'id' | 'owner_id'>): Promise<Role | null> {
  if (app.owner_id === u.id) return 'owner';
  const subs = subjects(u);
  const rows = await all<{ role: Role }>(`SELECT role FROM app_members WHERE app_id = ? AND subject IN (${subs.map(() => '?').join(', ')})`, app.id, ...subs);
  return rows.reduce<Role | null>((best, r) => (!best || RANK[r.role] > RANK[best] ? r.role : best), null);
}

/** The application if the user has at least `need` on it. */
export async function appFor(u: Pick<UserRow, 'id' | 'groups'>, appId: string, need: Role = 'viewer') {
  const app = await one<AppRow>('SELECT * FROM applications WHERE id = ?', appId);
  if (!app) return undefined;
  const role = await roleOn(u, app);
  return role && RANK[role] >= RANK[need] ? { app, role } : undefined;
}

/** SQL condition (on alias `a`) + params: applications the user can see. */
export function visibleApps(u: Pick<UserRow, 'id' | 'groups'>) {
  const subs = subjects(u);
  return {
    sql: `(a.owner_id = ? OR a.id IN (SELECT app_id FROM app_members WHERE subject IN (${subs.map(() => '?').join(', ')})))`,
    params: [u.id, ...subs],
  };
}

/** Every user who should receive an app's live events (owner + members, group members included). */
export async function audienceOf(appId: string): Promise<string[]> {
  const app = await one<{ owner_id: string }>('SELECT owner_id FROM applications WHERE id = ?', appId);
  if (!app) return [];
  const members = await all<{ subject: string }>('SELECT subject FROM app_members WHERE app_id = ?', appId);
  const ids = new Set([app.owner_id]);
  for (const { subject } of members) {
    if (subject.startsWith('user:')) ids.add(subject.slice(5));
    else for (const u of await all<{ id: string }>('SELECT id FROM users WHERE groups LIKE ?', `%"${subject.slice(6)}"%`)) ids.add(u.id);
  }
  return [...ids];
}
