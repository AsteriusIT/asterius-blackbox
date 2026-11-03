import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { one, run, type AppRow } from './db.js';

/**
 * Everything the user sees "live" goes through here:
 * it is persisted (so the UI can replay after reload) and fanned out to SSE subscribers of the app owner.
 */
export type BlackboxEventType =
  | 'app.updated' // application row changed (status / phase / repo)
  | 'message.created' // chat message (user or agent)
  | 'run.started'
  | 'run.finished'
  | 'progress' // high-level step reported by the agent (report_progress)
  | 'activity' // low-level: tool call the agent is making (git, edit, deploy…)
  | 'env.updated' // test environment state changed
  | 'pr.updated' // pull request opened / updated
  | 'notification'; // something the user should be pinged about

export interface BlackboxEvent {
  seq: number;
  appId: string;
  runId: string | null;
  type: BlackboxEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(
  appId: string,
  runId: string | null,
  type: BlackboxEventType,
  payload: Record<string, unknown>,
  opts: { persist?: boolean } = {},
): BlackboxEvent {
  const persist = opts.persist ?? true;
  let seq = 0;
  const createdAt = new Date().toISOString();
  if (persist) {
    const res = run(
      'INSERT INTO events (app_id, run_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      appId, runId, type, JSON.stringify(payload), createdAt,
    );
    seq = Number(res.lastInsertRowid);
  }
  const evt: BlackboxEvent = { seq, appId, runId, type, payload, createdAt };
  const app = one<Pick<AppRow, 'owner_id'>>('SELECT owner_id FROM applications WHERE id = ?', appId);
  if (app) bus.emit(`user:${app.owner_id}`, evt);
  if (type === 'notification') void forwardToWebhook(appId, payload);
  return evt;
}

export function subscribe(userId: string, fn: (e: BlackboxEvent) => void) {
  const key = `user:${userId}`;
  bus.on(key, fn);
  return () => bus.off(key, fn);
}

export function notify(
  appId: string,
  runId: string | null,
  n: { level: 'info' | 'success' | 'warning' | 'error'; title: string; message: string; link?: string },
) {
  return publish(appId, runId, 'notification', n);
}

async function forwardToWebhook(appId: string, payload: Record<string, unknown>) {
  if (!config.NOTIFY_WEBHOOK_URL) return;
  const app = one<Pick<AppRow, 'name'>>('SELECT name FROM applications WHERE id = ?', appId);
  const link = payload.link ? `\n${payload.link}` : '';
  const text = `**[${app?.name ?? appId}] ${payload.title}**\n${payload.message}${link}\n${config.PUBLIC_URL}/apps/${appId}`;
  try {
    await fetch(config.NOTIFY_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.warn('[notify] webhook failed', err);
  }
}
