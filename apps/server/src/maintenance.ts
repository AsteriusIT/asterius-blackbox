import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.js';
import { all, dialect, driver, run, withLock } from './db.js';

/**
 * Daily housekeeping (runs where the agents run: BLACKBOX_ROLE=all|worker).
 *  - Event retention: the low-level `activity` events (every tool call) of finished runs older than
 *    EVENTS_RETENTION_DAYS are deleted. Chat messages, milestones (progress, run.*, notifications, envs, PRs)
 *    are kept forever, so the timeline still tells the story.
 *  - Workspace GC: clones of deleted applications, or of applications idle for WORKSPACE_GC_DAYS, are removed;
 *    the next run re-clones them.
 */

const DAY = 86400_000;
const MAINTENANCE_LOCK = 726202;

export async function purgeOldEvents(now = Date.now()) {
  if (!config.EVENTS_RETENTION_DAYS) return 0;
  const cutoff = new Date(now - config.EVENTS_RETENTION_DAYS * DAY).toISOString();
  const { changes } = await run(
    `DELETE FROM events WHERE type = 'activity' AND created_at < ?
       AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM runs WHERE status IN ('queued', 'running')))`,
    cutoff,
  );
  // SQLite does not shrink the file by itself; Postgres' autovacuum reclaims the space.
  if (changes > 10_000 && dialect === 'sqlite') await driver.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
  return changes;
}

export async function collectWorkspaces(now = Date.now()) {
  if (!config.WORKSPACE_GC_DAYS || !fs.existsSync(paths.workspaces)) return [];
  const cutoff = new Date(now - config.WORKSPACE_GC_DAYS * DAY).toISOString();
  const apps = new Map(
    (
      await all<{ id: string; updated_at: string; busy: number }>(
        "SELECT id, updated_at, (SELECT count(*) FROM runs r WHERE r.app_id = a.id AND r.status IN ('queued', 'running')) AS busy FROM applications a",
      )
    ).map((a) => [a.id, a]),
  );
  const removed: string[] = [];
  for (const dir of fs.readdirSync(paths.workspaces)) {
    const app = apps.get(dir);
    // updated_at is either SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) or ISO; both compare correctly against ISO by date
    const idle = app && !Number(app.busy) && app.updated_at.replace(' ', 'T') < cutoff;
    if (app && !idle) continue;
    fs.rmSync(path.join(paths.workspaces, dir), { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

export async function runMaintenance(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {
  try {
    await withLock(MAINTENANCE_LOCK, async () => {
      const events = await purgeOldEvents();
      const workspaces = await collectWorkspaces();
      if (events || workspaces.length) log.info({ events, workspaces: workspaces.length }, 'maintenance done');
    });
  } catch (err) {
    log.warn({ err }, 'maintenance failed');
  }
}

export function startMaintenance(log: Parameters<typeof runMaintenance>[0]) {
  setTimeout(() => void runMaintenance(log), 60_000).unref();
  setInterval(() => void runMaintenance(log), DAY).unref();
}
