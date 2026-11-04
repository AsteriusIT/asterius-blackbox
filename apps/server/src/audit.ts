import { newId, one, run } from './db.js';

/**
 * Structured audit log of platform actions: who did what, through which channel, on which application.
 * Append-only; exported through GET /api/audit (JSON or CSV).
 */
export type AuditVia = 'api' | 'port' | 'agent' | 'system';

export interface AuditEntry {
  action: string; // app.created, repo.created, pr.opened, env.deployed, env.deleted, run.stopped, …
  via: AuditVia;
  actorId?: string | null;
  actorEmail?: string | null;
  appId?: string | null;
  target?: string | null; // PR id, environment name, repository…
  detail?: Record<string, unknown>;
}

export async function audit(e: AuditEntry) {
  try {
    const email = e.actorEmail ?? (e.actorId ? (await one<{ email: string }>('SELECT email FROM users WHERE id = ?', e.actorId))?.email : null);
    await run(
      'INSERT INTO audit_log (id, at, action, via, actor_id, actor_email, app_id, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId(),
      new Date().toISOString(),
      e.action,
      e.via,
      e.actorId ?? null,
      email ?? null,
      e.appId ?? null,
      e.target ?? null,
      JSON.stringify(e.detail ?? {}),
    );
  } catch (err) {
    console.error('[audit] could not record', e.action, err); // never break the action itself
  }
}

export interface AuditRow {
  id: string;
  at: string;
  action: string;
  via: AuditVia;
  actor_id: string | null;
  actor_email: string | null;
  app_id: string | null;
  target: string | null;
  detail: string;
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: AuditRow[]) {
  const cols: (keyof AuditRow)[] = ['at', 'action', 'via', 'actor_email', 'actor_id', 'app_id', 'target', 'detail'];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}
