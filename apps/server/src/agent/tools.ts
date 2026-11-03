import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { one, run, upsertEnv, type AppRow, type EnvRow } from '../db.js';
import { notify, publish } from '../events.js';
import { addMessage } from './messages.js';
import { exec, gitProvider, type RepoInfo } from '../providers/git.js';
import { kube, type Addon } from '../providers/kubernetes.js';

export interface ToolContext {
  app: AppRow;
  runId: string;
  workspace: string;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (text: string | object): ToolResult => ({
  content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }],
});
const fail = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

const K8S_TOOLS = new Set(['deploy_environment', 'environment_status', 'environment_logs', 'delete_environment']);

export const PHASES = ['understanding', 'planning', 'implementing', 'testing', 'deploying', 'reviewing', 'done', 'blocked'] as const;

function repoOf(app: AppRow): RepoInfo {
  if (!app.repo_id || !app.repo_clone_url) throw new Error('Repository is not provisioned yet');
  return { repoId: app.repo_id, name: app.repo_name!, webUrl: app.repo_web_url!, cloneUrl: app.repo_clone_url };
}

async function git(ws: string, ...args: string[]) {
  const { stdout } = await exec('git', ['-C', ws, ...args]);
  return stdout.trim();
}

/** Custom tools exposed to the agent as `mcp__blackbox__<name>`. Credentials stay in this process. */
export function blackboxTools(ctx: ToolContext) {
  const { app, runId } = ctx;

  return createSdkMcpServer({
    name: 'blackbox',
    version: '1.0.0',
    alwaysLoad: true,
    instructions:
      'Platform tools: progress reporting to the user, Azure DevOps pull requests/CI, and Kubernetes test environments. ' +
      'Git operations (clone/commit/push) are done with the git CLI in the workspace.',
    tools: [
      tool(
        'report_progress',
        'Tell the user, in one or two plain sentences, what you are doing at a high level. Call it whenever you start a new phase or finish a meaningful step (not for every file edit). This is what the user watches while you work.',
        {
          phase: z.enum(PHASES),
          title: z.string().describe('Short headline, e.g. "Scaffolding the API"'),
          detail: z.string().optional().describe('Optional extra context, 1-3 sentences'),
          step: z.number().int().optional(),
          totalSteps: z.number().int().optional(),
        },
        async (a) => {
          run('UPDATE applications SET phase = ?, updated_at = datetime(\'now\') WHERE id = ?', a.phase, app.id);
          publish(app.id, runId, 'progress', a);
          publish(app.id, runId, 'app.updated', { phase: a.phase });
          return ok('Progress shown to the user.');
        },
      ),

      tool(
        'share_plan',
        'Share your implementation plan with the user as a chat message, written for a non-technical reader first (what they will get), with technical notes second. Call it once after planning, and again only if the plan changes significantly.',
        {
          summary: z.string().describe('2-4 sentences in plain language: what will be built and how the user will be able to try it'),
          steps: z
            .array(z.object({ title: z.string().describe('Plain-language step, e.g. "Let members sign in"'), detail: z.string().optional().describe('Optional technical note') }))
            .min(1),
          stack: z.string().optional().describe('One line: chosen technologies'),
          questions: z.array(z.string()).optional().describe('Open questions for the user, if any'),
        },
        async (a) => {
          const lines = [
            '### Here is the plan',
            a.summary,
            '',
            ...a.steps.map((st, i) => `${i + 1}. **${st.title}**${st.detail ? ` — ${st.detail}` : ''}`),
          ];
          if (a.stack) lines.push('', `_Technology: ${a.stack}_`);
          if (a.questions?.length) lines.push('', '**A few questions for you**', ...a.questions.map((q) => `- ${q}`));
          addMessage(app.id, 'assistant', lines.join('\n'), runId);
          publish(app.id, runId, 'activity', { kind: 'plan-shared', title: 'Plan shared in the chat', steps: a.steps.map((st) => st.title) });
          return ok(
            config.AGENT_REQUIRE_PLAN_APPROVAL
              ? 'Plan shown to the user. This platform requires approval: end your turn now with a one-line question asking the user to confirm or adjust the plan.'
              : 'Plan shown to the user. Proceed with the implementation; the user can redirect you at any time.',
          );
        },
      ),

      tool(
        'notify_user',
        'Send a notification (toast, browser notification, and chat webhook if configured). Use for things that need the user\'s attention: an environment is ready, a PR needs review, you are blocked.',
        {
          level: z.enum(['info', 'success', 'warning', 'error']),
          title: z.string(),
          message: z.string(),
          link: z.string().optional(),
        },
        async (a) => {
          notify(app.id, runId, a);
          return ok('User notified.');
        },
      ),

      tool(
        'create_pull_request',
        'Open a pull request in Azure DevOps from a pushed feature branch to main. main is protected by branch policies, so this is the only way your work reaches main. A human must approve and complete it.',
        {
          sourceBranch: z.string().describe('Pushed branch name, e.g. feature/login'),
          title: z.string(),
          description: z.string().describe('Markdown: what changed, how to test, link to the test environment if any'),
        },
        async (a) => {
          try {
            const pr = await gitProvider().createPullRequest(repoOf(app), a);
            run(
              `INSERT OR REPLACE INTO pull_requests (id, app_id, title, source_branch, status, web_url) VALUES (?, ?, ?, ?, ?, ?)`,
              pr.id, app.id, pr.title, pr.sourceBranch, pr.status, pr.webUrl,
            );
            publish(app.id, runId, 'pr.updated', { ...pr });
            notify(app.id, runId, { level: 'info', title: `Pull request #${pr.id} opened`, message: pr.title, link: pr.webUrl });
            return ok({ id: pr.id, url: pr.webUrl, status: pr.status });
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'get_pull_request',
        'Read a pull request: status, reviewer votes, policy evaluations (build, reviewers, comments) and review comments. Use this to act on reviewer feedback.',
        { id: z.number().int() },
        async ({ id }) => {
          try {
            const pr = await gitProvider().getPullRequest(repoOf(app), id);
            run('UPDATE pull_requests SET status = ? WHERE app_id = ? AND id = ?', pr.status, app.id, id);
            publish(app.id, runId, 'pr.updated', { ...pr }, { persist: false });
            return ok(pr);
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'comment_on_pull_request',
        'Post a comment on a pull request (e.g. to answer a reviewer or summarize what you changed after feedback).',
        { id: z.number().int(), content: z.string() },
        async ({ id, content }) => {
          try {
            await gitProvider().commentOnPullRequest(repoOf(app), id, content);
            return ok('Comment posted.');
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'enable_ci',
        'After you have committed an Azure Pipelines YAML file to main via a merged PR (or on your branch), register it as a pipeline and make it a required build-validation policy on main. Call once per repository.',
        { yamlPath: z.string().default('azure-pipelines.yml') },
        async ({ yamlPath }) => {
          try {
            const msg = await gitProvider().enableBuildValidation(repoOf(app), yamlPath);
            publish(app.id, runId, 'activity', { kind: 'ci', title: 'CI enabled', detail: msg });
            return ok(msg);
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'deploy_environment',
        `Build the Dockerfile of a PUSHED branch inside the Kubernetes cluster and deploy it as an isolated test environment reachable at a public URL. ` +
          `Blocks until the environment is ready or failed (can take several minutes) and returns build/rollout logs on failure so you can fix and retry. ` +
          `The container must listen on 0.0.0.0:<port> and answer HTTP 200 on healthPath. Environments expire after ${config.K8S_ENV_TTL_HOURS}h. ` +
          `Addons give you ephemeral in-namespace services and inject env vars: postgres → DATABASE_URL (+PG*), redis → REDIS_URL. The user is notified automatically when it is ready.`,
        {
          envSlug: z.string().regex(/^[a-z0-9-]{1,20}$/).describe('Short id, e.g. "main", "pr-12", "feat-auth". Reusing a slug redeploys that environment.'),
          branch: z.string().describe('Branch that has been pushed to origin'),
          port: z.number().int().default(8080),
          healthPath: z.string().default('/'),
          dockerfile: z.string().default('Dockerfile'),
          contextSubPath: z.string().optional().describe('Sub-directory used as build context (monorepos)'),
          env: z.record(z.string(), z.string()).default({}).describe('Non-secret runtime environment variables'),
          addons: z.array(z.enum(['postgres', 'redis'])).default([]),
        },
        async (a) => {
          let envRow: EnvRow | undefined;
          try {
            const k = kube();
            const repo = repoOf(app);
            // Make sure we build exactly what is on the remote.
            await git(ctx.workspace, 'fetch', 'origin', a.branch);
            const remoteSha = await git(ctx.workspace, 'rev-parse', `origin/${a.branch}`);
            const localSha = await git(ctx.workspace, 'rev-parse', 'HEAD').catch(() => '');
            const warn = localSha && localSha !== remoteSha ? `\nWARNING: local HEAD (${localSha.slice(0, 8)}) differs from origin/${a.branch}; deploying the remote commit. Push first if that is not intended.` : '';

            const names = k.names(app.slug, a.envSlug);
            envRow = upsertEnv({ app_id: app.id, name: names.name, namespace: names.namespace, branch: a.branch, commit_sha: remoteSha, status: 'building', message: 'Queued', url: names.url });
            publish(app.id, runId, 'env.updated', { env: envRow });

            const res = await k.deploy({
              appId: app.id,
              appSlug: app.slug,
              repo,
              workspace: ctx.workspace,
              envSlug: a.envSlug,
              branch: a.branch,
              commitSha: remoteSha,
              port: a.port,
              healthPath: a.healthPath,
              dockerfile: a.dockerfile,
              contextSubPath: a.contextSubPath,
              env: a.env,
              addons: a.addons as Addon[],
              onStatus: (s) => {
                envRow = upsertEnv({ ...envRow!, status: s.stage === 'ready' ? 'ready' : s.stage, message: s.message });
                publish(app.id, runId, 'env.updated', { env: envRow });
                publish(app.id, runId, 'activity', { kind: 'deploy', title: s.message });
              },
            });
            envRow = upsertEnv({ ...envRow!, status: 'ready', url: res.url, image: res.image, expires_at: res.expiresAt, message: 'Ready' });
            publish(app.id, runId, 'env.updated', { env: envRow });
            notify(app.id, runId, {
              level: 'success',
              title: `Test environment "${a.envSlug}" is ready`,
              message: `${a.branch} @ ${remoteSha.slice(0, 8)} is deployed.`,
              link: res.url,
            });
            return ok(`Environment ready.\nURL: ${res.url}\nNamespace: ${res.namespace}\nImage: ${res.image}\nExpires: ${res.expiresAt}${warn}\nVerify it responds (e.g. curl -sf ${res.url}${a.healthPath}) before telling the user it works.`);
          } catch (err) {
            if (envRow) {
              envRow = upsertEnv({ ...envRow, status: 'failed', message: (err as Error).message.slice(0, 1000) });
              publish(app.id, runId, 'env.updated', { env: envRow });
            }
            return fail(err);
          }
        },
      ),

      tool(
        'environment_status',
        'Get pod status and recent warning events of a test environment.',
        { envSlug: z.string() },
        async ({ envSlug }) => {
          try {
            const k = kube();
            const { namespace, url } = k.names(app.slug, envSlug);
            return ok({ url, ...(await k.status(namespace)) });
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'environment_logs',
        'Tail logs of a component in a test environment (app, postgres or redis).',
        { envSlug: z.string(), component: z.enum(['app', 'postgres', 'redis']).default('app'), tail: z.number().int().max(2000).default(200) },
        async ({ envSlug, component, tail }) => {
          try {
            const k = kube();
            const { namespace } = k.names(app.slug, envSlug);
            return ok(await k.podLogs(namespace, `app.kubernetes.io/name=${component}`, tail));
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'delete_environment',
        'Tear down a test environment you no longer need.',
        { envSlug: z.string() },
        async ({ envSlug }) => {
          try {
            const k = kube();
            const { namespace, name } = k.names(app.slug, envSlug);
            await k.destroy(namespace);
            const row = one<EnvRow>('SELECT * FROM environments WHERE name = ?', name);
            if (row) publish(app.id, runId, 'env.updated', { env: upsertEnv({ ...row, status: 'deleted', message: 'Deleted by agent' }) });
            return ok(`Environment ${name} deleted.`);
          } catch (err) {
            return fail(err);
          }
        },
      ),
    ].filter((t) => config.K8S_ENABLED || !K8S_TOOLS.has(t.name)),
  });
}
