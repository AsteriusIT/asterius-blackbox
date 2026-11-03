import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { config } from './config.js';
import { all, upsertEnv, type EnvRow } from './db.js';
import { publish } from './events.js';
import { apiRoutes } from './routes/api.js';
import { recoverAfterRestart } from './agent/runner.js';
import { kube } from './providers/kubernetes.js';
import { startPortSync } from './integrations/port/sync.js';
import { portActionRoutes } from './integrations/port/actions.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', issues: err.issues });
  app.log.error(err);
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  return reply.code(status).send({ error: (err as Error).message });
});

app.get('/healthz', async () => ({ ok: true }));
await app.register(apiRoutes);
await app.register(portActionRoutes);

if (config.WEB_DIST_DIR && fs.existsSync(config.WEB_DIST_DIR)) {
  await app.register(fastifyStatic, { root: path.resolve(config.WEB_DIST_DIR), wildcard: false });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
  );
}

recoverAfterRestart();
startPortSync(app.log);

// Reap expired environments every 15 minutes.
if (config.K8S_ENABLED) {
  setInterval(async () => {
    try {
      const deleted = new Set(await kube().reapExpired());
      for (const env of all<EnvRow>("SELECT * FROM environments WHERE status != 'deleted'")) {
        if (deleted.has(env.namespace)) publish(env.app_id, null, 'env.updated', { env: upsertEnv({ ...env, status: 'deleted', message: 'Expired' }) });
      }
    } catch (err) {
      app.log.warn({ err }, 'environment reaper failed');
    }
  }, 15 * 60_000).unref();
}

if (!config.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) app.log.warn('ANTHROPIC_API_KEY is not set: the agent will not be able to run.');

await app.listen({ port: config.PORT, host: '0.0.0.0' });
