import { EventEmitter } from 'node:events';
import pg from 'pg';
import { config } from './config.js';
import { dialect, one, run, type AppRow, type EventRow } from './db.js';
import { audienceOf } from './access.js';

/**
 * Everything the user sees "live" goes through here:
 * it is persisted (so the UI can replay after reload) and fanned out to SSE subscribers of the app owner.
 */
export type { BlackboxEvent, BlackboxEventType } from '@blackbox/shared';
import type { BlackboxEvent, BlackboxEventType } from '@blackbox/shared';

const bus = new EventEmitter();
bus.setMaxListeners(0);

let chain: Promise<unknown> = Promise.resolve();

/**
 * Persist + fan out. Calls are serialized so events keep their call order (seq) even when callers do not await.
 * Failures are logged; callers that await still see them.
 */
export function publish(
  appId: string,
  runId: string | null,
  type: BlackboxEventType,
  payload: Record<string, unknown>,
  opts: { persist?: boolean } = {},
): Promise<BlackboxEvent> {
  const p = chain.then(() => doPublish(appId, runId, type, payload, opts.persist ?? true));
  chain = p.catch((err) => console.error('[events] publish failed', err));
  return p;
}

async function doPublish(appId: string, runId: string | null, type: BlackboxEventType, payload: Record<string, unknown>, persist: boolean) {
  let seq = 0;
  const createdAt = new Date().toISOString();
  if (persist) {
    const row = await one<{ seq: number }>(
      'INSERT INTO events (app_id, run_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?) RETURNING seq',
      appId,
      runId,
      type,
      JSON.stringify(payload),
      createdAt,
    );
    seq = Number(row!.seq);
  }
  const evt: BlackboxEvent = { seq, appId, runId, type, payload, createdAt };
  await fanOut(evt);
  // Integrations (Port sync, webhook) react once, on the instance that published the event.
  bus.emit('*', evt);
  if (type === 'notification') void forwardToWebhook(appId, payload);
  return evt;
}

// ---------- fan-out to SSE subscribers, across instances on Postgres (LISTEN/NOTIFY)
const CHANNEL = 'blackbox_events';
const NOTIFY_MAX = 7900; // Postgres caps NOTIFY payloads at 8000 bytes

async function deliver(evt: BlackboxEvent) {
  for (const userId of await audienceOf(evt.appId)) bus.emit(`user:${userId}`, evt);
}

async function fanOut(evt: BlackboxEvent) {
  if (dialect !== 'postgres') return deliver(evt);
  const json = JSON.stringify(evt);
  // Large persisted events travel by reference; large live-only ones (persist: false) stay on this instance.
  const msg = json.length <= NOTIFY_MAX ? json : evt.seq ? JSON.stringify({ ref: evt.seq }) : null;
  if (msg) await run('SELECT pg_notify(?, ?)', CHANNEL, msg);
  else await deliver(evt);
}

async function onNotify(payload: string | undefined) {
  if (!payload) return;
  const msg = JSON.parse(payload) as BlackboxEvent | { ref: number };
  if (!('ref' in msg)) return deliver(msg);
  const e = await one<EventRow>('SELECT * FROM events WHERE seq = ?', msg.ref);
  if (e)
    await deliver({ seq: e.seq, appId: e.app_id, runId: e.run_id, type: e.type as BlackboxEventType, payload: JSON.parse(e.payload), createdAt: e.created_at });
}

let deliveries: Promise<unknown> = Promise.resolve();
const relisten = (): void => void setTimeout(() => void listen().catch(relisten), 1000).unref();

// ---------- control signals between API and worker processes (run scheduling, feedback, stop)
export type ControlSignal = { type: 'wake' } | { type: 'feedback'; runId: string; messageId: string } | { type: 'stop'; runId: string };
const CONTROL = 'blackbox_control';
const control = new EventEmitter();
control.setMaxListeners(0);

export async function sendControl(c: ControlSignal) {
  if (dialect === 'postgres') await run('SELECT pg_notify(?, ?)', CONTROL, JSON.stringify(c));
  else control.emit('signal', c);
}
export function onControl(fn: (c: ControlSignal) => void) {
  control.on('signal', fn);
  return () => control.off('signal', fn);
}

async function listen(): Promise<void> {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  let lost = false;
  client.on('notification', (n) => {
    if (n.channel === CONTROL) return void control.emit('signal', JSON.parse(n.payload ?? '{}'));
    // Deliver in NOTIFY order (each delivery does an async owner lookup).
    deliveries = deliveries.then(() => onNotify(n.payload)).catch((err) => console.error('[events] delivery failed', err));
  });
  client.on('error', (err) => {
    if (lost) return;
    lost = true;
    console.warn('[events] LISTEN connection lost, reconnecting:', err.message);
    void client.end().catch(() => undefined);
    relisten();
  });
  await client.connect();
  await client.query(`LISTEN ${CHANNEL}; LISTEN ${CONTROL}`);
}

if (dialect === 'postgres') await listen();

/** Every event of every application (integrations such as the Port catalog sync). */
export function subscribeAll(fn: (e: BlackboxEvent) => void) {
  bus.on('*', fn);
  return () => bus.off('*', fn);
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
  const app = await one<Pick<AppRow, 'name'>>('SELECT name FROM applications WHERE id = ?', appId);
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
