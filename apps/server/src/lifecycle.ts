import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.js';
import { all, run, updateApp, upsertEnv, type AppRow, type EnvRow, type UserRow } from './db.js';
import { publish } from './events.js';
import { audit } from './audit.js';
import { addMessage, stopRun } from './agent/runner.js';
import { gitProvider, type RepoInfo } from './providers/git.js';
import { kube } from './providers/kubernetes.js';
import { removeFromPort } from './integrations/port/sync.js';

/**
 * End of life of an application.
 *  - archive: the agent is stopped, previews are torn down, the app becomes read-only (history and repository kept);
 *  - delete:  everything goes: previews, repository, Port entities, workspace and database rows (the audit log stays).
 */

async function tearDownEnvironments(app: AppRow, reason: string) {
  const envs = await all<EnvRow>("SELECT * FROM environments WHERE app_id = ? AND status != 'deleted'", app.id);
  for (const env of envs) {
    if (config.K8S_ENABLED) await kube().destroy(env.namespace);
    publish(app.id, null, 'env.updated', { env: await upsertEnv({ ...env, status: 'deleted', message: reason }) });
  }
  return envs;
}

export async function archiveApplication(app: AppRow, actor: UserRow) {
  await stopRun(app.id);
  const envs = await tearDownEnvironments(app, 'Application archived');
  await updateApp(app.id, { status: 'archived' });
  publish(app.id, null, 'app.updated', { status: 'archived' });
  await addMessage(app.id, 'system', `${actor.name} archived this application. It is read-only now; the repository and the history are kept.`);
  await audit({
    action: 'app.archived',
    via: 'api',
    actorId: actor.id,
    actorEmail: actor.email,
    appId: app.id,
    target: app.slug,
    detail: { environments: envs.length },
  });
}

export async function unarchiveApplication(app: AppRow, actor: UserRow) {
  await updateApp(app.id, { status: 'idle' });
  publish(app.id, null, 'app.updated', { status: 'idle' });
  await addMessage(app.id, 'system', `${actor.name} restored this application.`);
  await audit({ action: 'app.restored', via: 'api', actorId: actor.id, actorEmail: actor.email, appId: app.id, target: app.slug });
}

export async function deleteApplication(app: AppRow, actor: UserRow) {
  await stopRun(app.id);
  const envs = await tearDownEnvironments(app, 'Application deleted');
  // An imported repository belongs to its team: only repositories Blackbox created are deleted.
  if (app.repo_id && app.repo_clone_url && !app.repo_source) {
    const repo: RepoInfo = { repoId: app.repo_id, name: app.repo_name ?? app.slug, webUrl: app.repo_web_url ?? '', cloneUrl: app.repo_clone_url };
    await gitProvider().deleteRepository(repo);
  }
  await removeFromPort(app, envs);
  fs.rmSync(path.join(paths.workspaces, app.id), { recursive: true, force: true });
  await run('DELETE FROM applications WHERE id = ?', app.id); // cascades: messages, runs, events, environments, PRs, members
  await audit({
    action: 'app.deleted',
    via: 'api',
    actorId: actor.id,
    actorEmail: actor.email,
    appId: app.id,
    target: app.slug,
    detail: { name: app.name, repo: app.repo_web_url },
  });
}
