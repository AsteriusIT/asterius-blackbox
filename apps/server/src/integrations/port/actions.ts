import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { db, one, run, upsertEnv, type AppRow, type EnvRow, type UserRow } from '../../db.js';
import { publish, subscribeAll } from '../../events.js';
import { createApplication } from '../../applications.js';
import { addMessage, sendUserMessage, stopRun } from '../../agent/runner.js';
import { kube } from '../../providers/kubernetes.js';
import { port } from './client.js';

/**
 * Port self-service actions → Blackbox. Port signs each webhook (x-port-timestamp, x-port-signature: "v1,<base64 HMAC-SHA256>"
 * of `${timestamp}.${rawBody}` with the Port client secret). The body is the explicit template defined in
 * deploy/port/actions.json, so Blackbox never depends on Port's default payload shape.
 * Progress is mirrored back to the Port run (logs, link, final status).
 */

db.exec(`CREATE TABLE IF NOT EXISTS port_runs (
  run_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  action TEXT NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const TOLERANCE_S = 300;

export function verifyPortSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined, secret: string, now = Date.now()) {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_S) return false;
  const provided = signature.includes(',') ? signature.split(',')[1] : signature;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('base64');
  const a = Buffer.from(provided ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const payloadSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create_app'),
    runId: z.string(),
    user: z.string(),
    inputs: z.object({ name: z.string().min(2).max(60), description: z.string().max(4000).default(''), prompt: z.string().min(1).max(20000) }),
  }),
  z.object({ action: z.literal('send_feedback'), runId: z.string(), user: z.string(), entity: z.string(), inputs: z.object({ message: z.string().min(1).max(20000) }) }),
  z.object({ action: z.literal('stop_agent'), runId: z.string(), user: z.string(), entity: z.string() }),
  z.object({ action: z.literal('delete_preview'), runId: z.string(), user: z.string(), entity: z.string() }),
]);
export type PortActionPayload = z.infer<typeof payloadSchema>;

const chatUrl = (appId: string) => `${config.PUBLIC_URL.replace(/\/$/, '')}/apps/${appId}`;

/** Port users are matched to Blackbox users signed in with Entra (same work email); never auto-created. */
function userFor(email: string) {
  return one<UserRow>("SELECT * FROM users WHERE provider = 'entra' AND lower(email) = lower(?) ORDER BY last_login_at DESC LIMIT 1", email);
}

function track(runId: string, appId: string, action: string) {
  run('INSERT OR IGNORE INTO port_runs (run_id, app_id, action) VALUES (?, ?, ?)', runId, appId, action);
}

async function finish(runId: string, status: 'SUCCESS' | 'FAILURE', message: string) {
  run('UPDATE port_runs SET finished = 1 WHERE run_id = ?', runId);
  await port.logRun(runId, message, status).catch(() => undefined);
}

export async function handlePortAction(p: PortActionPayload): Promise<{ status: number; message: string }> {
  const user = userFor(p.user);
  if (!user) {
    await finish(p.runId, 'FAILURE', `${p.user} has no Blackbox account yet. Sign in once at ${config.PUBLIC_URL} with Microsoft, then run the action again.`);
    return { status: 403, message: 'unknown user' };
  }

  if (p.action === 'create_app') {
    const app = createApplication(user.id, p.inputs, (a) => track(p.runId, a.id, p.action));
    addMessage(app.id, 'system', `Requested from Port by ${p.user}.`);
    await port.updateRun(p.runId, { link: [chatUrl(app.id)], statusLabel: 'Setting up the repository' }).catch(() => undefined);
    await port.logRun(p.runId, `Application "${app.name}" created. Follow along in Blackbox: ${chatUrl(app.id)}`).catch(() => undefined);
    return { status: 202, message: app.id };
  }

  // Day-2 actions target a blackboxApplication (entity = app id) or a previewEnvironment (entity = env name).
  if (p.action === 'delete_preview') {
    const env = one<EnvRow>('SELECT * FROM environments WHERE name = ?', p.entity);
    const app = env && one<AppRow>('SELECT * FROM applications WHERE id = ? AND owner_id = ?', env.app_id, user.id);
    if (!env || !app) {
      await finish(p.runId, 'FAILURE', 'Preview not found, or it does not belong to you.');
      return { status: 404, message: 'not found' };
    }
    await kube().destroy(env.namespace);
    publish(app.id, null, 'env.updated', { env: upsertEnv({ ...env, status: 'deleted', message: `Deleted from Port by ${p.user}` }) });
    await finish(p.runId, 'SUCCESS', `Preview ${env.name} deleted.`);
    return { status: 200, message: 'deleted' };
  }

  const app = one<AppRow>('SELECT * FROM applications WHERE id = ? AND owner_id = ?', p.entity, user.id);
  if (!app) {
    await finish(p.runId, 'FAILURE', 'Application not found, or it does not belong to you.');
    return { status: 404, message: 'not found' };
  }
  if (p.action === 'stop_agent') {
    const stopped = await stopRun(app.id);
    await finish(p.runId, 'SUCCESS', stopped ? 'The agent was stopped.' : 'The agent was not running.');
    return { status: 200, message: 'stopped' };
  }
  // send_feedback
  sendUserMessage(app, p.inputs.message);
  track(p.runId, app.id, p.action);
  await port.updateRun(p.runId, { link: [chatUrl(app.id)], statusLabel: 'Delivered to the agent' }).catch(() => undefined);
  return { status: 202, message: 'delivered' };
}

/** Mirror Blackbox progress into the open Port runs of each application. */
function mirrorProgress() {
  subscribeAll((e) => {
    if (!['progress', 'notification', 'run.finished', 'app.updated'].includes(e.type)) return;
    const runs = db.prepare('SELECT run_id FROM port_runs WHERE app_id = ? AND finished = 0').all(e.appId) as { run_id: string }[];
    for (const { run_id } of runs) {
      const p = e.payload as Record<string, unknown>;
      if (e.type === 'progress') void port.logRun(run_id, String(p.title ?? '')).catch(() => undefined);
      if (e.type === 'notification' && p.link) {
        void port.logRun(run_id, `${p.title}: ${p.link}`).catch(() => undefined);
        void port.updateRun(run_id, { link: [chatUrl(e.appId), String(p.link)] }).catch(() => undefined);
      }
      if (e.type === 'app.updated' && p.status === 'error' && p.last_error && !one('SELECT 1 FROM applications WHERE id = ? AND repo_id IS NOT NULL', e.appId))
        void finish(run_id, 'FAILURE', `Provisioning failed: ${p.last_error}`);
      if (e.type === 'run.finished')
        void finish(run_id, p.status === 'succeeded' ? 'SUCCESS' : 'FAILURE', p.status === 'succeeded' ? 'The agent finished. Review the result in Blackbox.' : `The agent stopped (${p.status}).`);
    }
  });
}

export async function portActionRoutes(app: FastifyInstance) {
  if (!config.PORT_ACTIONS_ENABLED) return;
  if (!port.enabled) throw new Error('PORT_ACTIONS_ENABLED requires PORT_CLIENT_ID and PORT_CLIENT_SECRET');
  mirrorProgress();

  await app.register(async (r) => {
    // Keep the raw body: the signature is computed over the exact bytes Port sent.
    r.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    });

    r.post('/api/integrations/port/webhook', async (req, reply) => {
      const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
      const ok = verifyPortSignature(raw, req.headers['x-port-timestamp'] as string, req.headers['x-port-signature'] as string, config.PORT_CLIENT_SECRET!);
      if (!ok) return reply.code(401).send({ error: 'invalid signature' });
      const parsed = payloadSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid payload', issues: parsed.error.issues });
      const res = await handlePortAction(parsed.data);
      return reply.code(res.status).send({ ok: res.status < 300, result: res.message });
    });
  });
}
