import { config } from './config.js';
import { one, upsertEnv, type AppRow, type EnvRow } from './db.js';
import { notify, publish } from './events.js';
import { audit, type AuditVia } from './audit.js';
import { metrics } from './metrics.js';
import { configFor } from './app-config.js';
import { exec, type RepoInfo } from './providers/git.js';
import { kube, type Addon } from './providers/kubernetes.js';

/**
 * Preview environments: deploy (agent tool, promotion, auto-redeploy of staging after a merge), TTL and pinning.
 * A pinned environment never expires; `staging` is the long-lived environment that follows main.
 */

export interface DeploySpec {
  port: number;
  healthPath: string;
  dockerfile: string;
  contextSubPath?: string;
  /** Non-secret variables chosen by the agent (people's configuration is added at deploy time). */
  env: Record<string, string>;
  addons: Addon[];
}

export const STAGING = 'staging';

const repoOf = (app: AppRow): RepoInfo => {
  if (!app.repo_id || !app.repo_clone_url) throw new Error('Repository is not provisioned yet');
  return { repoId: app.repo_id, name: app.repo_name!, webUrl: app.repo_web_url!, cloneUrl: app.repo_clone_url };
};
const git = async (ws: string, ...args: string[]) => (await exec('git', ['-C', ws, ...args])).stdout.trim();

export async function deployEnvironment(p: {
  app: AppRow;
  runId: string | null;
  workspace: string;
  envSlug: string;
  branch: string;
  spec: DeploySpec;
  via: AuditVia;
  actorId?: string | null;
  pinned?: boolean;
}) {
  const { app, runId } = p;
  let envRow: EnvRow | undefined;
  try {
    const k = kube();
    // Build exactly what is on the remote.
    await git(p.workspace, 'fetch', 'origin', p.branch);
    const remoteSha = await git(p.workspace, 'rev-parse', `origin/${p.branch}`);
    const localSha = await git(p.workspace, 'rev-parse', 'HEAD').catch(() => '');
    const names = k.names(app.slug, p.envSlug);
    const existing = await one<EnvRow>('SELECT * FROM environments WHERE name = ?', names.name);
    const pinned = p.pinned ?? existing?.pinned === 1;

    envRow = await upsertEnv({
      app_id: app.id,
      name: names.name,
      namespace: names.namespace,
      branch: p.branch,
      commit_sha: remoteSha,
      status: 'building',
      message: 'Queued',
      url: names.url,
    });
    publish(app.id, runId, 'env.updated', { env: envRow });

    const injected = await configFor(app.id, p.envSlug);
    const res = await k.deploy({
      appId: app.id,
      appSlug: app.slug,
      repo: repoOf(app),
      workspace: p.workspace,
      envSlug: p.envSlug,
      branch: p.branch,
      commitSha: remoteSha,
      port: p.spec.port,
      healthPath: p.spec.healthPath,
      dockerfile: p.spec.dockerfile,
      contextSubPath: p.spec.contextSubPath,
      env: { ...p.spec.env, ...injected }, // people's configuration wins over the agent's defaults
      addons: p.spec.addons,
      expiresAt: pinned ? 'never' : undefined,
      onStatus: async (s) => {
        envRow = await upsertEnv({ ...envRow!, status: s.stage === 'ready' ? 'ready' : s.stage, message: s.message });
        publish(app.id, runId, 'env.updated', { env: envRow });
        publish(app.id, runId, 'activity', { kind: 'deploy', title: s.message });
      },
    });
    metrics.build('ready');
    await audit({
      action: 'env.deployed',
      via: p.via,
      actorId: p.actorId,
      appId: app.id,
      target: envRow!.name,
      detail: { runId, branch: p.branch, commit: remoteSha, url: res.url },
    });
    envRow = await upsertEnv({
      ...envRow!,
      status: 'ready',
      url: res.url,
      image: res.image,
      expires_at: pinned ? null : res.expiresAt,
      pinned: pinned ? 1 : 0,
      spec: JSON.stringify(p.spec),
      message: 'Ready',
    });
    publish(app.id, runId, 'env.updated', { env: envRow });
    notify(app.id, runId, {
      level: 'success',
      title: `Test environment "${p.envSlug}" is ready`,
      message: `${p.branch} @ ${remoteSha.slice(0, 8)} is deployed.`,
      link: res.url,
    });
    return {
      env: envRow,
      res,
      injected: Object.keys(injected),
      warning:
        localSha && localSha !== remoteSha
          ? `local HEAD (${localSha.slice(0, 8)}) differs from origin/${p.branch}; deployed the remote commit. Push first if that is not intended.`
          : null,
    };
  } catch (err) {
    metrics.build('failed');
    if (envRow)
      publish(app.id, runId, 'env.updated', { env: await upsertEnv({ ...envRow, status: 'failed', message: (err as Error).message.slice(0, 1000) }) });
    throw err;
  }
}

const DAY_MS = 86400_000;

export async function extendEnvironment(app: AppRow, env: EnvRow, hours: number, actorId: string) {
  if (env.pinned) return env;
  const from = Math.max(Date.now(), env.expires_at ? Date.parse(env.expires_at) : Date.now());
  const expiresAt = new Date(Math.min(from + hours * 3600_000, Date.now() + config.K8S_ENV_MAX_TTL_DAYS * DAY_MS)).toISOString();
  await kube().setExpiry(env.namespace, expiresAt);
  const updated = await upsertEnv({ ...env, expires_at: expiresAt });
  publish(app.id, null, 'env.updated', { env: updated });
  await audit({ action: 'env.extended', via: 'api', actorId, appId: app.id, target: env.name, detail: { expiresAt } });
  return updated;
}

export async function pinEnvironment(app: AppRow, env: EnvRow, pinned: boolean, actorId: string) {
  const expiresAt = pinned ? null : new Date(Date.now() + config.K8S_ENV_TTL_HOURS * 3600_000).toISOString();
  await kube().setExpiry(env.namespace, expiresAt ?? 'never');
  const updated = await upsertEnv({ ...env, pinned: pinned ? 1 : 0, expires_at: expiresAt });
  publish(app.id, null, 'env.updated', { env: updated });
  await audit({ action: pinned ? 'env.pinned' : 'env.unpinned', via: 'api', actorId, appId: app.id, target: env.name });
  return updated;
}

/** Redeploy `main` as the pinned `staging` environment, with the build settings of `from` (or staging's own). */
export async function promoteToStaging(app: AppRow, workspace: string, from: EnvRow, via: AuditVia, actorId: string | null) {
  if (!from.spec)
    throw Object.assign(new Error('This environment was deployed before promotion existed: ask the agent to redeploy it first.'), { statusCode: 409 });
  return deployEnvironment({ app, runId: null, workspace, envSlug: STAGING, branch: 'main', spec: JSON.parse(from.spec), via, actorId, pinned: true });
}
