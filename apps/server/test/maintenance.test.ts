import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../src/config.js';
import { all, newId, run } from '../src/db.js';
import { createUser } from '../src/auth.js';
import { collectWorkspaces, purgeOldEvents } from '../src/maintenance.js';

const DAY = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

async function app(ownerId: string, updatedAt: string) {
  const id = newId();
  await run(
    'INSERT INTO applications (id, owner_id, name, slug, description, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    ownerId,
    'A',
    id,
    '',
    'idle',
    updatedAt,
  );
  return id;
}

describe('maintenance', () => {
  it('drops old activity of finished runs, keeps milestones, messages and live runs', async () => {
    const u = await createUser(`m${Date.now()}@x.io`, 'M', 'password1');
    const a = await app(u.id, ago(0));
    const done = newId();
    const live = newId();
    await run("INSERT INTO runs (id, app_id, status) VALUES (?, ?, 'succeeded')", done, a);
    await run("INSERT INTO runs (id, app_id, status) VALUES (?, ?, 'running')", live, a);
    const ev = (runId: string, type: string, at: string) =>
      run('INSERT INTO events (app_id, run_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)', a, runId, type, '{}', at);
    await ev(done, 'activity', ago(40)); // purged
    await ev(done, 'progress', ago(40)); // milestone: kept
    await ev(done, 'activity', ago(5)); // recent: kept
    await ev(live, 'activity', ago(40)); // run still live: kept
    expect(await purgeOldEvents()).toBe(1);
    expect((await all<{ type: string }>('SELECT type FROM events WHERE app_id = ? ORDER BY seq', a)).map((e) => e.type)).toEqual([
      'progress',
      'activity',
      'activity',
    ]);
  });

  it('removes workspaces of deleted and long-idle applications only', async () => {
    const u = await createUser(`w${Date.now()}@x.io`, 'W', 'password1');
    const active = await app(u.id, ago(1));
    const idle = await app(u.id, ago(30));
    const busy = await app(u.id, ago(30));
    await run("INSERT INTO runs (id, app_id, status) VALUES (?, ?, 'queued')", newId(), busy);
    for (const id of [active, idle, busy, 'deleted-app']) fs.mkdirSync(path.join(paths.workspaces, id, '.git'), { recursive: true });
    expect((await collectWorkspaces()).sort()).toEqual(['deleted-app', idle].sort());
    expect(fs.readdirSync(paths.workspaces).sort()).toEqual([active, busy].sort());
  });
});
