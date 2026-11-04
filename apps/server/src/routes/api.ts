import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { all, one, run, updateApp, upsertEnv, type AppRow, type EnvRow, type EventRow, type MessageRow, type PullRequestRow, type UserRow } from '../db.js';
import { publish, subscribe } from '../events.js';
import {
  bearer,
  createSession,
  createStreamTicket,
  createUser,
  deleteAllSessions,
  deleteSession,
  loginLockedFor,
  publicUser,
  recordLoginFailure,
  recordLoginSuccess,
  redeemStreamTicket,
  requireUser,
  verifyPassword,
} from '../auth.js';
import { entraRoutes } from '../entra.js';
import { createApplication } from '../applications.js';
import { portSyncStatus } from '../integrations/port/sync.js';
import { addMessage, prepareWorkspace, provisionApp, sendUserMessage, stopRun } from '../agent/runner.js';
import { gitProvider } from '../providers/git.js';
import { kube } from '../providers/kubernetes.js';
import { metrics } from '../metrics.js';
import type { Members, Platform, RunHistory } from '@blackbox/shared';
import { branchDiff } from '../diff.js';
import { getTemplate, listTemplates } from '../templates.js';
import { extendEnvironment, pinEnvironment, promoteToStaging, STAGING } from '../environments.js';
import { CONFIG_KEY, deleteConfig, listConfig, setConfig } from '../app-config.js';
import fs from 'node:fs';
import { attachmentPath, attachmentsOf, saveAttachments, uploadSchema } from '../agent/attachments.js';
import { audit, toCsv, type AuditRow } from '../audit.js';
import { isAdmin } from '../auth.js';
import { costReport, setBudget, type Scope } from '../costs.js';
import { archiveApplication, deleteApplication, unarchiveApplication } from '../lifecycle.js';
import { appFor, roleOn, visibleApps, type Role } from '../access.js';

const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
const messageLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => bearer(req) ?? req.ip } } };

/** The application if the signed-in user has at least `need` on it (owner, or member of the app). */
async function appOf(user: UserRow, id: string, need: Role = 'viewer') {
  return (await appFor(user, id, need))?.app;
}

const appView = (a: AppRow) => ({ ...a, running: a.status === 'running' });

export async function apiRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ auth
  const localAuth = config.AUTH_PROVIDERS.includes('local');
  if (config.AUTH_PROVIDERS.includes('entra')) await app.register(entraRoutes);

  app.post('/api/auth/register', authLimit, async (req, reply) => {
    if (!localAuth || !config.ALLOW_REGISTRATION) return reply.code(403).send({ error: 'Registration is disabled' });
    const body = z.object({ email: z.email(), name: z.string().min(1), password: z.string().min(8) }).parse(req.body);
    if (await one("SELECT 1 FROM users WHERE provider = 'local' AND email = ?", body.email.toLowerCase()))
      return reply.code(409).send({ error: 'Email already registered' });
    const user = await createUser(body.email, body.name, body.password);
    return { token: await createSession(user.id), user: publicUser(user) };
  });

  app.post('/api/auth/login', authLimit, async (req, reply) => {
    if (!localAuth) return reply.code(403).send({ error: 'Password sign-in is disabled' });
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const email = body.email.toLowerCase();
    const wait = loginLockedFor(email);
    if (wait)
      return reply
        .code(429)
        .header('retry-after', wait)
        .send({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} min.` });
    const user = await one<UserRow>("SELECT * FROM users WHERE provider = 'local' AND email = ?", email);
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      recordLoginFailure(email);
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    recordLoginSuccess(email);
    // Rotate: a token presented with the login is replaced by the new one.
    const previous = bearer(req);
    if (previous) await deleteSession(previous);
    return { token: await createSession(user.id), user: publicUser(user) };
  });

  app.get('/api/platform', async (): Promise<Platform> => ({
    gitProvider: gitProvider().kind,
    adoProject: config.GIT_PROVIDER === 'github' ? (config.GITHUB_OWNER ?? null) : (config.ADO_PROJECT ?? null),
    policies: gitProvider().describePolicies(),
    k8sEnabled: config.K8S_ENABLED,
    baseDomain: config.K8S_BASE_DOMAIN,
    plannerModel: config.AGENT_PLANNER_MODEL,
    coderModel: config.AGENT_CODER_MODEL,
    buildMode: config.K8S_BUILD_MODE,
    authProviders: config.AUTH_PROVIDERS,
    port: { ...portSyncStatus, actions: config.PORT_ACTIONS_ENABLED },
    allowRegistration: localAuth && config.ALLOW_REGISTRATION,
    requirePlanApproval: config.AGENT_REQUIRE_PLAN_APPROVAL,
  }));

  // ------------------------------------------------------------ authenticated
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/me', async (req) => publicUser(req.user));

    r.post('/api/auth/logout', async (req) => {
      const token = bearer(req);
      if (token) await deleteSession(token);
      return { ok: true };
    });

    r.post('/api/auth/logout-all', async (req) => {
      await deleteAllSessions(req.user.id);
      return { ok: true };
    });

    // Dashboard: one row per app with what a user needs at a glance.
    r.get('/api/apps', async (req) =>
      (
        await all<AppRow & { live_env_url: string | null; env_count: number; open_prs: number; last_progress: string | null; last_activity_at: string | null }>(
          `SELECT a.*,
           (SELECT url FROM environments e WHERE e.app_id = a.id AND e.status = 'ready' ORDER BY e.updated_at DESC LIMIT 1) AS live_env_url,
           (SELECT count(*) FROM environments e WHERE e.app_id = a.id AND e.status != 'deleted') AS env_count,
           (SELECT count(*) FROM pull_requests p WHERE p.app_id = a.id AND p.status = 'active') AS open_prs,
           (SELECT json_extract(payload, '$.title') FROM events ev WHERE ev.app_id = a.id AND ev.type = 'progress' ORDER BY ev.seq DESC LIMIT 1) AS last_progress,
           (SELECT max(created_at) FROM events ev WHERE ev.app_id = a.id) AS last_activity_at
         FROM applications a WHERE ${visibleApps(req.user).sql} ORDER BY a.updated_at DESC`,
          ...visibleApps(req.user).params,
        )
      ).map(appView),
    );

    r.get('/api/templates', async () => listTemplates());

    r.post('/api/apps', async (req, reply) => {
      const body = z
        .object({
          name: z.string().min(2).max(60),
          description: z.string().max(4000).default(''),
          prompt: z.string().min(1).max(20000),
          template: z.string().max(60).optional(),
          /** Existing repository: ADO name/URL, or a local path with GIT_PROVIDER=local. */
          importFrom: z.string().min(1).max(500).optional(),
        })
        .parse(req.body);
      if (body.template && !getTemplate(body.template)) return reply.code(400).send({ error: `Unknown template ${body.template}` });
      return appView(await createApplication(req.user.id, body));
    });

    r.get('/api/apps/:id', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'viewer');
      if (!a) return reply.code(404).send({ error: 'not found' });
      return {
        app: appView(a),
        role: await roleOn(req.user, a),
        environments: await all<EnvRow>("SELECT * FROM environments WHERE app_id = ? AND status != 'deleted' ORDER BY updated_at DESC", a.id),
        pullRequests: await all<PullRequestRow>('SELECT * FROM pull_requests WHERE app_id = ? ORDER BY id DESC', a.id),
        runs: await all('SELECT * FROM runs WHERE app_id = ? ORDER BY started_at DESC LIMIT 20', a.id),
      };
    });

    r.get('/api/apps/:id/messages', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'viewer');
      if (!a) return reply.code(404).send({ error: 'not found' });
      return await all<MessageRow>('SELECT * FROM messages WHERE app_id = ? ORDER BY created_at, id', a.id);
    });

    r.get('/api/apps/:id/events', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'viewer');
      if (!a) return reply.code(404).send({ error: 'not found' });
      const q = z
        .object({ after: z.coerce.number().default(0), limit: z.coerce.number().max(2000).default(500), runId: z.string().optional() })
        .parse(req.query);
      // newest `limit` events after `after` (optionally of one run: replay), returned oldest-first
      const byRun = q.runId ? 'AND run_id = ?' : '';
      return (
        await all<EventRow>(
          `SELECT * FROM (SELECT * FROM events WHERE app_id = ? AND seq > ? ${byRun} ORDER BY seq DESC LIMIT ?) AS e ORDER BY seq`,
          ...([a.id, q.after, ...(q.runId ? [q.runId] : []), q.limit] as (string | number)[]),
        )
      ).map((e) => ({
        seq: e.seq,
        appId: e.app_id,
        runId: e.run_id,
        type: e.type,
        payload: JSON.parse(e.payload),
        createdAt: e.created_at,
      }));
    });

    r.get('/api/apps/:id/attachments/:file', async (req, reply) => {
      const { id, file } = req.params as { id: string; file: string };
      const a = await appOf(req.user, id, 'viewer');
      const p = a && attachmentPath(a.id, file);
      if (!p) return reply.code(404).send({ error: 'not found' });
      const meta = (await all<MessageRow>('SELECT meta FROM messages WHERE app_id = ? AND meta LIKE ?', a.id, `%${file}%`))
        .flatMap(attachmentsOf)
        .find((x) => x.file === file);
      return reply
        .type(meta?.mediaType ?? 'application/octet-stream')
        .header('content-disposition', `inline; filename="${(meta?.name ?? file).replace(/"/g, '')}"`)
        .header('x-content-type-options', 'nosniff')
        .send(fs.createReadStream(p));
    });

    r.get('/api/apps/:id/diff', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'viewer');
      if (!a) return reply.code(404).send({ error: 'not found' });
      if (!a.repo_id) return reply.code(409).send({ error: 'The repository is not ready yet.' });
      const { branch } = z.object({ branch: z.string().min(1).max(200) }).parse(req.query);
      return branchDiff(a, branch);
    });

    // Run history: what each run cost, how long it took and what it produced.
    r.get('/api/apps/:id/runs', async (req, reply): Promise<RunHistory[] | void> => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'viewer');
      if (!a) return reply.code(404).send({ error: 'not found' });
      const runs = await all<{
        id: string;
        status: string;
        cost_usd: number | null;
        num_turns: number | null;
        summary: string | null;
        started_at: string;
        ended_at: string | null;
      }>(
        "SELECT id, status, cost_usd, num_turns, summary, started_at, ended_at FROM runs WHERE app_id = ? AND status != 'queued' ORDER BY started_at DESC LIMIT 100",
        a.id,
      );
      const produced = await all<{ run_id: string; type: string; payload: string }>(
        "SELECT run_id, type, payload FROM events WHERE app_id = ? AND type IN ('pr.updated', 'env.updated') AND run_id IS NOT NULL",
        a.id,
      );
      return runs.map((r) => {
        const mine = produced.filter((p) => p.run_id === r.id).map((p) => ({ type: p.type, payload: JSON.parse(p.payload) }));
        const prs = [
          ...new Map(
            mine.filter((p) => p.type === 'pr.updated').map((p) => [p.payload.id, { id: p.payload.id, title: p.payload.title, url: p.payload.webUrl }]),
          ).values(),
        ];
        const envs = [
          ...new Map(
            mine.filter((p) => p.type === 'env.updated').map((p) => [p.payload.env.name, { name: p.payload.env.name, url: p.payload.env.url }]),
          ).values(),
        ];
        const end = r.ended_at ? Date.parse(r.ended_at.includes('T') ? r.ended_at : r.ended_at.replace(' ', 'T') + 'Z') : NaN;
        const start = Date.parse(r.started_at.includes('T') ? r.started_at : r.started_at.replace(' ', 'T') + 'Z');
        return { ...r, durationSeconds: Number.isNaN(end) ? null : Math.round((end - start) / 1000), pullRequests: prs, environments: envs };
      });
    });

    r.post('/api/apps/:id/messages', { ...messageLimit, bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'editor');
      if (!a) return reply.code(404).send({ error: 'not found' });
      const { content, attachments } = z.object({ content: z.string().min(1).max(20000), attachments: uploadSchema }).parse(req.body);
      if (a.status === 'error' && !a.repo_id) return reply.code(409).send({ error: 'Repository provisioning failed; retry it first.' });
      if (a.status === 'archived') return reply.code(409).send({ error: 'This application is archived (read-only). Its owner can restore it.' });
      const res = await sendUserMessage(a, content, saveAttachments(a.id, attachments));
      if (res.blocked) return reply.code(402).send({ error: res.blocked });
      return res;
    });

    r.post('/api/apps/:id/stop', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'editor');
      if (!a) return reply.code(404).send({ error: 'not found' });
      const stopped = await stopRun(a.id);
      if (stopped) await audit({ action: 'run.stopped', via: 'api', actorId: req.user.id, actorEmail: req.user.email, appId: a.id });
      return { stopped };
    });

    r.post('/api/apps/:id/retry-provisioning', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'editor');
      if (!a) return reply.code(404).send({ error: 'not found' });
      if (a.repo_id) return reply.code(409).send({ error: 'Repository already exists' });
      await run("UPDATE applications SET status = 'provisioning', last_error = NULL WHERE id = ?", a.id);
      // the kickoff message is still waiting in the app's queued run
      void provisionApp(a.id);
      return { ok: true };
    });

    r.delete('/api/apps/:id/environments/:envId', async (req, reply) => {
      const { id, envId } = req.params as { id: string; envId: string };
      const a = await appOf(req.user, id, 'editor');
      const env = await one<EnvRow>('SELECT * FROM environments WHERE id = ? AND app_id = ?', envId, id);
      if (!a || !env) return reply.code(404).send({ error: 'not found' });
      await kube().destroy(env.namespace);
      await audit({ action: 'env.deleted', via: 'api', actorId: req.user.id, actorEmail: req.user.email, appId: a.id, target: env.name });
      const updated = await upsertEnv({ ...env, status: 'deleted', message: 'Deleted by user' });
      publish(a.id, null, 'env.updated', { env: updated });
      await addMessage(a.id, 'system', `Environment ${env.name} was deleted by the user.`);
      return { ok: true };
    });

    // ------------------------------------------------------------ per-application settings (editors)
    r.patch('/api/apps/:id', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'editor');
      if (!a) return reply.code(404).send({ error: 'not found' });
      const body = z.object({ requirePlanApproval: z.boolean().nullable().optional() }).parse(req.body);
      if (body.requirePlanApproval !== undefined) {
        const v = body.requirePlanApproval === null ? null : body.requirePlanApproval ? 1 : 0;
        await updateApp(a.id, { require_plan_approval: v });
        publish(a.id, null, 'app.updated', { require_plan_approval: v });
        await audit({ action: 'app.settings', via: 'api', actorId: req.user.id, actorEmail: req.user.email, appId: a.id, detail: body });
      }
      return appView((await one<AppRow>('SELECT * FROM applications WHERE id = ?', a.id))!);
    });

    // ------------------------------------------------------------ preview lifetime & promotion (editors)
    const envOf = async (req: FastifyRequest) => {
      const { id, envId } = req.params as { id: string; envId: string };
      const a = await appOf(req.user, id, 'editor');
      const env = a && (await one<EnvRow>("SELECT * FROM environments WHERE id = ? AND app_id = ? AND status != 'deleted'", envId, a.id));
      return a && env ? { a, env } : null;
    };
    r.post('/api/apps/:id/environments/:envId/extend', async (req, reply) => {
      const found = await envOf(req);
      if (!found) return reply.code(404).send({ error: 'not found' });
      const { hours } = z
        .object({
          hours: z
            .number()
            .int()
            .min(1)
            .max(24 * 30)
            .default(24),
        })
        .parse(req.body ?? {});
      return extendEnvironment(found.a, found.env, hours, req.user.id);
    });
    r.post('/api/apps/:id/environments/:envId/pin', async (req, reply) => {
      const found = await envOf(req);
      if (!found) return reply.code(404).send({ error: 'not found' });
      const { pinned } = z.object({ pinned: z.boolean() }).parse(req.body);
      return pinEnvironment(found.a, found.env, pinned, req.user.id);
    });
    r.post('/api/apps/:id/environments/:envId/promote', async (req, reply) => {
      const found = await envOf(req);
      if (!found) return reply.code(404).send({ error: 'not found' });
      if (!found.env.spec)
        return reply.code(409).send({ error: 'This environment was deployed before promotion existed: ask the agent to redeploy it first.' });
      const ws = await prepareWorkspace(found.a);
      // Builds can take minutes: answer now, progress arrives as env.updated events.
      void promoteToStaging(found.a, ws, found.env, 'api', req.user.id).catch((err) => req.log.warn({ err }, 'promotion failed'));
      return { ok: true, environment: STAGING };
    });

    // ------------------------------------------------------------ configuration & secrets (editors; values encrypted)
    r.get('/api/apps/:id/config', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'editor');
      if (!a) return reply.code(404).send({ error: 'not found' });
      return listConfig(a.id);
    });

    r.put('/api/apps/:id/config', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'editor');
      if (!a) return reply.code(404).send({ error: 'not found' });
      const body = z
        .object({
          key: z.string().regex(CONFIG_KEY, 'Use UPPER_SNAKE_CASE names, e.g. STRIPE_API_KEY'),
          value: z.string().max(32_000),
          secret: z.boolean().default(true),
          env: z
            .string()
            .regex(/^(\*|[a-z0-9-]{1,20})$/)
            .default('*'),
        })
        .parse(req.body);
      await setConfig(a.id, body);
      await audit({
        action: 'config.set',
        via: 'api',
        actorId: req.user.id,
        actorEmail: req.user.email,
        appId: a.id,
        target: body.key,
        detail: { env: body.env, secret: body.secret },
      });
      return { ok: true };
    });

    r.delete('/api/apps/:id/config/:key', async (req, reply) => {
      const { id, key } = req.params as { id: string; key: string };
      const a = await appOf(req.user, id, 'editor');
      if (!a) return reply.code(404).send({ error: 'not found' });
      const env = String((req.query as { env?: string }).env ?? '*');
      if (await deleteConfig(a.id, key, env))
        await audit({ action: 'config.deleted', via: 'api', actorId: req.user.id, actorEmail: req.user.email, appId: a.id, target: key, detail: { env } });
      return { ok: true };
    });

    // ------------------------------------------------------------ end of life (owner)
    r.post('/api/apps/:id/archive', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'owner');
      if (!a) return reply.code(404).send({ error: 'not found' });
      if (a.status === 'archived') return { ok: true };
      await archiveApplication(a, req.user);
      return { ok: true };
    });

    r.post('/api/apps/:id/unarchive', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'owner');
      if (!a) return reply.code(404).send({ error: 'not found' });
      if (a.status === 'archived') await unarchiveApplication(a, req.user);
      return { ok: true };
    });

    r.delete('/api/apps/:id', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'owner');
      if (!a) return reply.code(404).send({ error: 'not found' });
      const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
      if (confirm !== a.name) return reply.code(400).send({ error: `Type the application name ("${a.name}") to confirm the deletion.` });
      await deleteApplication(a, req.user);
      return { ok: true };
    });

    // ------------------------------------------------------------ sharing (owner manages members)
    r.get('/api/apps/:id/members', async (req, reply): Promise<Members | void> => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'viewer');
      if (!a) return reply.code(404).send({ error: 'not found' });
      const owner = await one<UserRow>('SELECT * FROM users WHERE id = ?', a.owner_id);
      const rows = await all<{ subject: string; role: 'viewer' | 'editor'; email: string | null; name: string | null }>(
        `SELECT m.subject, m.role, u.email, u.name FROM app_members m LEFT JOIN users u ON m.subject = 'user:' || u.id WHERE m.app_id = ? ORDER BY m.created_at`,
        a.id,
      );
      return {
        owner: owner ? { id: owner.id, email: owner.email, name: owner.name } : null,
        members: rows.map((m) => ({
          subject: m.subject,
          role: m.role,
          email: m.email,
          name: m.name ?? (m.subject.startsWith('group:') ? `Entra group ${m.subject.slice(6)}` : null),
        })),
      };
    });

    r.post('/api/apps/:id/members', async (req, reply) => {
      const a = await appOf(req.user, (req.params as { id: string }).id, 'owner');
      if (!a) return reply.code(404).send({ error: 'not found' });
      const body = z
        .object({ email: z.email().optional(), groupId: z.uuid().optional(), role: z.enum(['viewer', 'editor']) })
        .refine((b) => Boolean(b.email) !== Boolean(b.groupId), 'Give either an email or an Entra group id')
        .parse(req.body);
      let subject: string;
      if (body.email) {
        const u = await one<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?) ORDER BY last_login_at DESC LIMIT 1', body.email);
        if (!u) return reply.code(404).send({ error: `${body.email} has no Blackbox account yet: ask them to sign in once.` });
        if (u.id === a.owner_id) return reply.code(409).send({ error: 'That person already owns this application.' });
        subject = `user:${u.id}`;
      } else subject = `group:${body.groupId}`;
      await run(
        'INSERT INTO app_members (app_id, subject, role, added_by) VALUES (?, ?, ?, ?) ON CONFLICT (app_id, subject) DO UPDATE SET role = excluded.role',
        a.id,
        subject,
        body.role,
        req.user.id,
      );
      await audit({
        action: 'member.added',
        via: 'api',
        actorId: req.user.id,
        actorEmail: req.user.email,
        appId: a.id,
        target: subject,
        detail: { role: body.role },
      });
      return { ok: true, subject };
    });

    r.delete('/api/apps/:id/members/:subject', async (req, reply) => {
      const { id, subject } = req.params as { id: string; subject: string };
      const a = await appOf(req.user, id, 'owner');
      if (!a) return reply.code(404).send({ error: 'not found' });
      const { changes } = await run('DELETE FROM app_members WHERE app_id = ? AND subject = ?', a.id, subject);
      if (changes) await audit({ action: 'member.removed', via: 'api', actorId: req.user.id, actorEmail: req.user.email, appId: a.id, target: subject });
      return { ok: true };
    });

    // ------------------------------------------------------------ costs & budgets
    r.get('/api/costs', async (req) => costReport(req.user, visibleApps(req.user), isAdmin(req.user)));

    r.put('/api/budgets', async (req, reply) => {
      if (!isAdmin(req.user)) return reply.code(403).send({ error: 'Only platform administrators can change budgets' });
      const body = z.object({ scope: z.string().regex(/^(global|user:[\w-]+|app:[\w-]+)$/), monthlyUsd: z.number().min(0).nullable() }).parse(req.body);
      await setBudget(body.scope as Scope, body.monthlyUsd);
      await audit({
        action: 'budget.set',
        via: 'api',
        actorId: req.user.id,
        actorEmail: req.user.email,
        target: body.scope,
        detail: { monthlyUsd: body.monthlyUsd },
      });
      return { ok: true };
    });

    // Audit log: your applications' entries (platform admins: everything). ?format=csv to export.
    r.get('/api/audit', async (req, reply) => {
      const q = z
        .object({
          appId: z.string().optional(),
          since: z.string().optional(),
          limit: z.coerce.number().max(10000).default(500),
          format: z.enum(['json', 'csv']).default('json'),
        })
        .parse(req.query);
      const admin = isAdmin(req.user);
      const where = ['1 = 1'];
      const params: (string | number)[] = [];
      if (!admin) {
        const v = visibleApps(req.user);
        where.push(`(l.actor_id = ? OR l.app_id IN (SELECT a.id FROM applications a WHERE ${v.sql}))`);
        params.push(req.user.id, ...v.params);
      }
      if (q.appId) {
        where.push('l.app_id = ?');
        params.push(q.appId);
      }
      if (q.since) {
        where.push('l.at >= ?');
        params.push(q.since);
      }
      const rows = await all<AuditRow>(`SELECT l.* FROM audit_log l WHERE ${where.join(' AND ')} ORDER BY l.at DESC LIMIT ?`, ...params, q.limit);
      if (q.format === 'csv') return reply.type('text/csv').header('content-disposition', 'attachment; filename="blackbox-audit.csv"').send(toCsv(rows));
      return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
    });

    r.post('/api/stream-ticket', async (req) => ({ ticket: await createStreamTicket(req.user.id) }));
  });

  // ------------------------------------------------------------ live stream (SSE, authenticated by a single-use ticket)
  app.get('/api/stream', async (req, reply) => {
    const user = await redeemStreamTicket((req.query as { ticket?: string }).ticket);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const unsub = subscribe(user.id, (e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
    metrics.sseOpened();
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsub();
      metrics.sseClosed();
    });
    return reply; // keep open
  });
}
