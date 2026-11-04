import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { config } from './config.js';
import { all, upsertEnv, type EnvRow } from './db.js';
import { publish } from './events.js';
import { apiRoutes } from './routes/api.js';
import { recoverAfterRestart, startScheduler, WORKER_ID } from './agent/runner.js';
import { kube } from './providers/kubernetes.js';
import { startPortSync } from './integrations/port/sync.js';
import { portActionRoutes } from './integrations/port/actions.js';
import { purgeExpiredAuth } from './auth.js';
import { startMaintenance } from './maintenance.js';
import { isReady, readiness } from './health.js';
import { registry } from './metrics.js';
import { initTracing } from './tracing.js';
import { audit } from './audit.js';
import { startPrFeedback } from './integrations/pr-feedback.js';

initTracing(config.BLACKBOX_ROLE);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', issues: err.issues });
  app.log.error(err);
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  return reply.code(status).send({ error: (err as Error).message });
});

const https = config.PUBLIC_URL.startsWith('https://');
await app.register(helmet, {
  hsts: https,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://rsms.me'],
      fontSrc: ["'self'", 'https://rsms.me'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: https ? [] : null,
    },
  },
});
// Opt-in per route (`config.rateLimit`): auth and message endpoints.
await app.register(rateLimit, { global: false });

app.get('/healthz', async () => ({ ok: true }));
app.get('/metrics', async (req, reply) => {
  if (config.METRICS_TOKEN && req.headers.authorization !== `Bearer ${config.METRICS_TOKEN}`) return reply.code(401).send({ error: 'unauthorized' });
  return reply.type(registry.contentType).send(await registry.metrics());
});
app.get('/readyz', async (_req, reply) => {
  const checks = await readiness();
  return reply.code(isReady(checks) ? 200 : 503).send({ ok: Object.values(checks).every((c) => c.ok), checks });
});

const serveApi = config.BLACKBOX_ROLE !== 'worker';
const runAgents = config.BLACKBOX_ROLE !== 'api';

if (serveApi) {
  await app.register(apiRoutes);
  await app.register(portActionRoutes);

  if (config.WEB_DIST_DIR && fs.existsSync(config.WEB_DIST_DIR)) {
    await app.register(fastifyStatic, { root: path.resolve(config.WEB_DIST_DIR), wildcard: false });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
  }

  await recoverAfterRestart();
  const purge = () => purgeExpiredAuth().catch((err) => app.log.warn({ err }, 'session purge failed'));
  void purge();
  setInterval(purge, 60 * 60_000).unref();

  startPrFeedback(app.log);

  // Reap expired environments every 15 minutes.
  if (config.K8S_ENABLED) {
    setInterval(async () => {
      try {
        const deleted = new Set(await kube().reapExpired());
        for (const env of await all<EnvRow>("SELECT * FROM environments WHERE status != 'deleted'")) {
          if (!deleted.has(env.namespace)) continue;
          publish(env.app_id, null, 'env.updated', { env: await upsertEnv({ ...env, status: 'deleted', message: 'Expired' }) });
          await audit({ action: 'env.expired', via: 'system', appId: env.app_id, target: env.name });
        }
      } catch (err) {
        app.log.warn({ err }, 'environment reaper failed');
      }
    }, 15 * 60_000).unref();
  }
}
// Catalog sync reacts to the events published by this process (API actions and agent runs).
startPortSync(app.log);
if (runAgents) {
  await startScheduler();
  startMaintenance(app.log);
}
app.log.info(`role=${config.BLACKBOX_ROLE}${runAgents ? ` worker=${WORKER_ID}` : ''}`);

if (!config.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) app.log.warn('ANTHROPIC_API_KEY is not set: the agent will not be able to run.');

await app.listen({ port: config.PORT, host: '0.0.0.0' });
