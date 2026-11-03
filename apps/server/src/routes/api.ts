import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { all, newId, one, run, upsertEnv, type AppRow, type EnvRow, type EventRow, type MessageRow, type PullRequestRow, type UserRow } from '../db.js';
import { publish, subscribe } from '../events.js';
import { createSession, createUser, deleteSession, publicUser, requireUser, verifyPassword } from '../auth.js';
import { entraRoutes } from '../entra.js';
import { createApplication } from '../applications.js';
import { portSyncStatus } from '../integrations/port/sync.js';
import { addMessage, isRunning, provisionApp, queueBeforeReady, sendUserMessage, stopRun } from '../agent/runner.js';
import { gitProvider } from '../providers/git.js';
import { kube } from '../providers/kubernetes.js';

function ownApp(userId: string, id: string) {
  return one<AppRow>('SELECT * FROM applications WHERE id = ? AND owner_id = ?', id, userId);
}

const appView = (a: AppRow) => ({ ...a, running: isRunning(a.id) });

export async function apiRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ auth
  const localAuth = config.AUTH_PROVIDERS.includes('local');
  if (config.AUTH_PROVIDERS.includes('entra')) await app.register(entraRoutes);

  app.post('/api/auth/register', async (req, reply) => {
    if (!localAuth || !config.ALLOW_REGISTRATION) return reply.code(403).send({ error: 'Registration is disabled' });
    const body = z.object({ email: z.email(), name: z.string().min(1), password: z.string().min(8) }).parse(req.body);
    if (one("SELECT 1 FROM users WHERE provider = 'local' AND email = ?", body.email.toLowerCase())) return reply.code(409).send({ error: 'Email already registered' });
    const user = createUser(body.email, body.name, body.password);
    return { token: createSession(user.id), user: publicUser(user) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (!localAuth) return reply.code(403).send({ error: 'Password sign-in is disabled' });
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const user = one<UserRow>("SELECT * FROM users WHERE provider = 'local' AND email = ?", body.email.toLowerCase());
    if (!user || !verifyPassword(body.password, user.password_hash)) return reply.code(401).send({ error: 'Invalid credentials' });
    return { token: createSession(user.id), user: publicUser(user) };
  });

  app.get('/api/platform', async () => ({
    gitProvider: gitProvider().kind,
    adoProject: config.ADO_PROJECT ?? null,
    policies: gitProvider().describePolicies(),
    k8sEnabled: config.K8S_ENABLED,
    baseDomain: config.K8S_BASE_DOMAIN,
    plannerModel: config.AGENT_PLANNER_MODEL,
    coderModel: config.AGENT_CODER_MODEL,
    buildMode: config.K8S_BUILD_MODE,
    authProviders: config.AUTH_PROVIDERS,
    port: { ...portSyncStatus, actions: config.PORT_ACTIONS_ENABLED },
    allowRegistration: localAuth && config.ALLOW_REGISTRATION,
  }));

  // ------------------------------------------------------------ authenticated
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/me', async (req) => publicUser(req.user));

    r.post('/api/auth/logout', async (req) => {
      const token = req.headers.authorization?.slice(7);
      if (token) deleteSession(token);
      return { ok: true };
    });

    // Dashboard: one row per app with what a user needs at a glance.
    r.get('/api/apps', async (req) =>
      all<AppRow & { live_env_url: string | null; env_count: number; open_prs: number; last_progress: string | null; last_activity_at: string | null }>(
        `SELECT a.*,
           (SELECT url FROM environments e WHERE e.app_id = a.id AND e.status = 'ready' ORDER BY e.updated_at DESC LIMIT 1) AS live_env_url,
           (SELECT count(*) FROM environments e WHERE e.app_id = a.id AND e.status != 'deleted') AS env_count,
           (SELECT count(*) FROM pull_requests p WHERE p.app_id = a.id AND p.status = 'active') AS open_prs,
           (SELECT json_extract(payload, '$.title') FROM events ev WHERE ev.app_id = a.id AND ev.type = 'progress' ORDER BY ev.seq DESC LIMIT 1) AS last_progress,
           (SELECT max(created_at) FROM events ev WHERE ev.app_id = a.id) AS last_activity_at
         FROM applications a WHERE a.owner_id = ? ORDER BY a.updated_at DESC`,
        req.user.id,
      ).map(appView),
    );

    r.post('/api/apps', async (req) => {
      const body = z
        .object({ name: z.string().min(2).max(60), description: z.string().max(4000).default(''), prompt: z.string().min(1).max(20000) })
        .parse(req.body);
      return appView(createApplication(req.user.id, body));
    });

    r.get('/api/apps/:id', async (req, reply) => {
      const a = ownApp(req.user.id, (req.params as { id: string }).id);
      if (!a) return reply.code(404).send({ error: 'not found' });
      return {
        app: appView(a),
        environments: all<EnvRow>("SELECT * FROM environments WHERE app_id = ? AND status != 'deleted' ORDER BY updated_at DESC", a.id),
        pullRequests: all<PullRequestRow>('SELECT * FROM pull_requests WHERE app_id = ? ORDER BY id DESC', a.id),
        runs: all('SELECT * FROM runs WHERE app_id = ? ORDER BY started_at DESC LIMIT 20', a.id),
      };
    });

    r.get('/api/apps/:id/messages', async (req, reply) => {
      const a = ownApp(req.user.id, (req.params as { id: string }).id);
      if (!a) return reply.code(404).send({ error: 'not found' });
      return all<MessageRow>('SELECT * FROM messages WHERE app_id = ? ORDER BY created_at, rowid', a.id);
    });

    r.get('/api/apps/:id/events', async (req, reply) => {
      const a = ownApp(req.user.id, (req.params as { id: string }).id);
      if (!a) return reply.code(404).send({ error: 'not found' });
      const q = z.object({ after: z.coerce.number().default(0), limit: z.coerce.number().max(2000).default(500) }).parse(req.query);
      // newest `limit` events after `after`, returned oldest-first
      return all<EventRow>('SELECT * FROM (SELECT * FROM events WHERE app_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq', a.id, q.after, q.limit).map((e) => ({
        seq: e.seq,
        appId: e.app_id,
        runId: e.run_id,
        type: e.type,
        payload: JSON.parse(e.payload),
        createdAt: e.created_at,
      }));
    });

    r.post('/api/apps/:id/messages', async (req, reply) => {
      const a = ownApp(req.user.id, (req.params as { id: string }).id);
      if (!a) return reply.code(404).send({ error: 'not found' });
      const { content } = z.object({ content: z.string().min(1).max(20000) }).parse(req.body);
      if (a.status === 'error' && !a.repo_id) return reply.code(409).send({ error: 'Repository provisioning failed; retry it first.' });
      return sendUserMessage(a, content);
    });

    r.post('/api/apps/:id/stop', async (req, reply) => {
      const a = ownApp(req.user.id, (req.params as { id: string }).id);
      if (!a) return reply.code(404).send({ error: 'not found' });
      return { stopped: await stopRun(a.id) };
    });

    r.post('/api/apps/:id/retry-provisioning', async (req, reply) => {
      const a = ownApp(req.user.id, (req.params as { id: string }).id);
      if (!a) return reply.code(404).send({ error: 'not found' });
      if (a.repo_id) return reply.code(409).send({ error: 'Repository already exists' });
      run("UPDATE applications SET status = 'provisioning', last_error = NULL WHERE id = ?", a.id);
      const firstUser = one<MessageRow>("SELECT * FROM messages WHERE app_id = ? AND role = 'user' ORDER BY created_at LIMIT 1", a.id);
      // re-queue the kickoff message (its chat row already exists)
      if (firstUser) queueBeforeReady(a.id, firstUser.content);
      void provisionApp(a.id);
      return { ok: true };
    });

    r.delete('/api/apps/:id/environments/:envId', async (req, reply) => {
      const { id, envId } = req.params as { id: string; envId: string };
      const a = ownApp(req.user.id, id);
      const env = one<EnvRow>('SELECT * FROM environments WHERE id = ? AND app_id = ?', envId, id);
      if (!a || !env) return reply.code(404).send({ error: 'not found' });
      await kube().destroy(env.namespace);
      const updated = upsertEnv({ ...env, status: 'deleted', message: 'Deleted by user' });
      publish(a.id, null, 'env.updated', { env: updated });
      addMessage(a.id, 'system', `Environment ${env.name} was deleted by the user.`);
      return { ok: true };
    });

    // ------------------------------------------------------------ live stream (SSE)
    r.get('/api/stream', (req, reply) => {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      reply.raw.write(': connected\n\n');
      const unsub = subscribe(req.user.id, (e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
      req.raw.on('close', () => {
        clearInterval(ping);
        unsub();
      });
      return reply; // keep open
    });
  });
}
