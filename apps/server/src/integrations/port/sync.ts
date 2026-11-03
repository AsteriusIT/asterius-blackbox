import { config } from '../../config.js';
import { all, one, type AppRow, type EnvRow } from '../../db.js';
import { subscribeAll, type BlackboxEventType } from '../../events.js';
import { port, PortError } from './client.js';
import { applicationEntity, BP, previewEntity, serviceEntity, serviceId, type AppFacts } from './mapping.js';

/**
 * One-way catalog sync Blackbox → Port. Event-driven (debounced per application) plus a periodic full
 * reconcile. Never blocks the product: failures are logged and retried on the next pass.
 */

const TRIGGERS = new Set<BlackboxEventType>(['app.updated', 'run.started', 'run.finished', 'progress', 'env.updated', 'pr.updated']);
const DEBOUNCE_MS = 3000;
const RECONCILE_MS = 30 * 60_000;

export const portSyncStatus = { enabled: false, lastSyncAt: null as string | null, lastError: null as string | null, synced: 0 };

const dirty = new Set<string>();
let timer: NodeJS.Timeout | undefined;
let flushing: Promise<void> | undefined;
const teamCache = new Map<string, { team: string[] | undefined; at: number }>();
const knownServices = new Set<string>();
const deletedPreviews = new Set<string>();

type Log = { info: (o: object | string, m?: string) => void; warn: (o: object | string, m?: string) => void };

export function startPortSync(log: Log) {
  if (!port.enabled) return;
  portSyncStatus.enabled = true;
  subscribeAll((e) => {
    if (TRIGGERS.has(e.type)) markDirty(e.appId);
  });
  const reconcile = () => {
    for (const a of all<{ id: string }>('SELECT id FROM applications')) dirty.add(a.id);
    void flush(log);
  };
  setTimeout(reconcile, 2000).unref();
  setInterval(reconcile, RECONCILE_MS).unref();
  log.info(`Port catalog sync enabled (${config.PORT_API_URL})`);

  function markDirty(appId: string) {
    dirty.add(appId);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(log), DEBOUNCE_MS);
  }
}

async function flush(log: Log): Promise<void> {
  if (flushing) return flushing.then((): Promise<void> => flush(log));
  flushing = (async () => {
    const ids = [...dirty];
    dirty.clear();
    for (const id of ids) {
      try {
        await syncApplication(id);
        portSyncStatus.synced++;
        portSyncStatus.lastSyncAt = new Date().toISOString();
        portSyncStatus.lastError = null;
      } catch (err) {
        portSyncStatus.lastError = (err as Error).message;
        log.warn({ err: (err as Error).message, appId: id }, 'Port sync failed (will retry)');
        dirty.add(id); // retried on next event or reconcile
      }
    }
  })().finally(() => (flushing = undefined));
  return flushing;
}

export function collectFacts(app: AppRow): AppFacts {
  const owner = one<{ email: string }>('SELECT email FROM users WHERE id = ?', app.owner_id);
  const stats = one<{ cost: number | null; runs: number }>('SELECT sum(cost_usd) AS cost, count(*) AS runs FROM runs WHERE app_id = ?', app.id);
  const progress = one<{ title: string | null; at: string }>(
    "SELECT json_extract(payload, '$.title') AS title, created_at AS at FROM events WHERE app_id = ? AND type = 'progress' ORDER BY seq DESC LIMIT 1",
    app.id,
  );
  const last = one<{ at: string | null }>('SELECT max(created_at) AS at FROM events WHERE app_id = ?', app.id);
  const prs = one<{ n: number }>("SELECT count(*) AS n FROM pull_requests WHERE app_id = ? AND status = 'active'", app.id);
  const live = one<{ url: string | null }>("SELECT url FROM environments WHERE app_id = ? AND status = 'ready' ORDER BY updated_at DESC LIMIT 1", app.id);
  return {
    app,
    ownerEmail: owner?.email ?? null,
    lastProgress: progress?.title ?? null,
    lastActivity: last?.at ?? null,
    totalCostUsd: stats?.cost ?? 0,
    runs: stats?.runs ?? 0,
    openPrs: prs?.n ?? 0,
    livePreviewUrl: live?.url ?? null,
    isAzureRepo: Boolean(app.repo_web_url?.startsWith('https://dev.azure.com') || app.repo_web_url?.includes('visualstudio.com')),
  };
}

/** Owner teams: the requester's Port teams, else PORT_DEFAULT_TEAM, else leave ownership untouched. */
async function teamFor(email: string | null): Promise<string[] | undefined> {
  const fallback = config.PORT_DEFAULT_TEAM ? [config.PORT_DEFAULT_TEAM] : undefined;
  if (!email) return fallback;
  const cached = teamCache.get(email);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.team;
  let team = fallback;
  try {
    const user = await port.getEntity('_user', email);
    if (user?.team?.length) team = user.team;
  } catch (err) {
    if (!(err instanceof PortError && err.status === 403)) throw err;
  }
  teamCache.set(email, { team, at: Date.now() });
  return team;
}

export async function syncApplication(appId: string) {
  const app = one<AppRow>('SELECT * FROM applications WHERE id = ?', appId);
  if (!app) return;
  const facts = collectFacts(app);
  const team = await teamFor(facts.ownerEmail);

  // 1. Service: shared with humans (criticality, ownership edits…) → merge, and only set the team on creation.
  if (config.PORT_SYNC_SERVICES) {
    const sid = serviceId(app);
    let exists = knownServices.has(sid);
    if (!exists) exists = Boolean(await port.getEntity(BP.service, sid));
    await port.upsertEntity(BP.service, serviceEntity(facts, exists ? undefined : team), { merge: true, createMissingRelated: true });
    knownServices.add(sid);
  }

  // 2. Application: fully owned by Blackbox → replace.
  await port.upsertEntity(BP.app, applicationEntity(facts, team), { merge: false, createMissingRelated: true });

  // 3. Previews.
  for (const env of all<EnvRow>('SELECT * FROM environments WHERE app_id = ?', app.id)) {
    if (env.status === 'deleted') {
      if (deletedPreviews.has(env.name)) continue;
      await port.deleteEntity(BP.preview, env.name);
      deletedPreviews.add(env.name);
    } else {
      deletedPreviews.delete(env.name);
      await port.upsertEntity(BP.preview, previewEntity(env, team), { merge: false });
    }
  }
}
