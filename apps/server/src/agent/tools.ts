import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { all, one, run, upsertEnv, type AppRow, type EnvRow } from '../db.js';
import { notify, publish } from '../events.js';
import { addMessage, needsPlanApproval } from './messages.js';
import { AGENT_COMMENT_MARK, exec, gitProvider, type RepoInfo } from '../providers/git.js';
import { kube, type Addon } from '../providers/kubernetes.js';
import { scanDiff } from '../security/secrets.js';
import { configNames } from '../app-config.js';
import { deployEnvironment } from '../environments.js';
import { audit } from '../audit.js';
import { withSpan } from '../tracing.js';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { portAgentTools, portAgentToolsEnabled } from '../integrations/port/agent-tools.js';

export interface ToolContext {
  app: AppRow;
  runId: string;
  workspace: string;
  /** Run span: tool spans are its children (the SDK calls handlers outside the run's async context). */
  span?: Span;
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

/** Secret scan of what the PR would bring to main (lines added by origin/<branch> since it forked from origin/main). */
async function scanBranch(ws: string, branch: string) {
  await exec('git', ['-C', ws, 'fetch', '-q', 'origin', 'main', branch]).catch(() => {
    throw new Error(`Branch "${branch}" was not found on origin: push it first.`);
  });
  const { stdout } = await exec('git', ['-C', ws, 'diff', '--no-color', '--unified=0', `origin/main...origin/${branch}`], { maxBuffer: 64 * 1024 * 1024 });
  return scanDiff(stdout);
}

/** Custom tools exposed to the agent as `mcp__blackbox__<name>`. Credentials stay in this process. */
export function blackboxTools(ctx: ToolContext) {
  const { app, runId } = ctx;

  return createSdkMcpServer({
    name: 'blackbox',
    version: '1.0.0',
    alwaysLoad: true,
    instructions:
      'Platform tools: progress reporting to the user, pull requests/CI on the git provider, and Kubernetes test environments. ' +
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
          await run("UPDATE applications SET phase = ?, updated_at = datetime('now') WHERE id = ?", a.phase, app.id);
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
            .array(
              z.object({
                title: z.string().describe('Plain-language step, e.g. "Let members sign in"'),
                detail: z.string().optional().describe('Optional technical note'),
              }),
            )
            .min(1),
          stack: z.string().optional().describe('One line: chosen technologies'),
          questions: z.array(z.string()).optional().describe('Open questions for the user, if any'),
        },
        async (a) => {
          const lines = ['### Here is the plan', a.summary, '', ...a.steps.map((st, i) => `${i + 1}. **${st.title}**${st.detail ? ` — ${st.detail}` : ''}`)];
          if (a.stack) lines.push('', `_Technology: ${a.stack}_`);
          if (a.questions?.length) lines.push('', '**A few questions for you**', ...a.questions.map((q) => `- ${q}`));
          // Re-read the setting: the user may have toggled it since the run started.
          const approval = needsPlanApproval((await one<AppRow>('SELECT require_plan_approval FROM applications WHERE id = ?', app.id)) ?? app);
          await addMessage(app.id, 'assistant', lines.join('\n'), runId, { type: 'plan', needsApproval: approval });
          publish(app.id, runId, 'activity', { kind: 'plan-shared', title: 'Plan shared in the chat', steps: a.steps.map((st) => st.title) });
          return ok(
            approval
              ? 'Plan shown to the user. This platform requires approval: end your turn now with a one-line question asking the user to confirm or adjust the plan.'
              : 'Plan shown to the user. Proceed with the implementation; the user can redirect you at any time.',
          );
        },
      ),

      tool(
        'list_app_config',
        'List the configuration variables and secrets people set for this application in Blackbox (names only, never values). ' +
          'They are injected as environment variables into every preview: read them from the environment in the code (process.env.X, os.environ["X"]…), never hard-code values, and document them in the README.',
        {},
        async () => {
          const rows = await configNames(app.id);
          return ok(
            rows.length
              ? rows.map((r) => `- ${r.key}${r.secret ? ' (secret)' : ''}${r.env === '*' ? '' : ` — only in environment "${r.env}"`}`).join('\n')
              : 'No configuration set yet. If the app needs an API key or other secret, ask the user to add it in the application settings (Settings → Configuration & secrets).',
          );
        },
      ),

      tool(
        'notify_user',
        "Send a notification (toast, browser notification, and chat webhook if configured). Use for things that need the user's attention: an environment is ready, a PR needs review, you are blocked.",
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
        'Open a pull request from a pushed feature branch to main. main is protected by branch policies, so this is the only way your work reaches main. A human must approve and complete it.',
        {
          sourceBranch: z.string().describe('Pushed branch name, e.g. feature/login'),
          title: z.string(),
          description: z.string().describe('Markdown: what changed, how to test, link to the test environment if any'),
        },
        async (a) => {
          try {
            const findings = await scanBranch(ctx.workspace, a.sourceBranch);
            if (findings.length) {
              const list = findings.map((f) => `- ${f.file}:${f.line} [${f.rule}] ${f.preview}`).join('\n');
              publish(app.id, runId, 'activity', {
                kind: 'error',
                title: `Pull request blocked: ${findings.length} possible secret(s) in the changes`,
                detail: list,
              });
              return fail(
                `Pull request blocked: the changes contain what looks like secrets.\n${list}\n` +
                  'Move them to environment variables. Because force pushes are not allowed, create a fresh branch from origin/main with the cleaned-up changes, ' +
                  'push it and open the pull request from that branch. Tell the user which credential must be rotated. ' +
                  'If a finding is a false positive (test fixture, placeholder), rewrite the value so it is obviously fake (e.g. "changeme").',
              );
            }
            // The requester (owner) and the app's editors review it, so the provider notifies them.
            const reviewerEmails = (
              await all<{ email: string }>(
                `SELECT u.email FROM users u WHERE u.id = ?
                 UNION SELECT u.email FROM app_members m JOIN users u ON m.subject = 'user:' || u.id WHERE m.app_id = ? AND m.role = 'editor'`,
                app.owner_id,
                app.id,
              )
            ).map((r) => r.email);
            const pr = await gitProvider().createPullRequest(repoOf(app), { ...a, reviewerEmails });
            await run(
              // feedback_seen starts empty: the review loop reacts to every reviewer comment from now on
              `INSERT INTO pull_requests (id, app_id, title, source_branch, status, web_url, feedback_seen) VALUES (?, ?, ?, ?, ?, ?, '{"comments":[],"failing":[]}')
               ON CONFLICT (app_id, id) DO UPDATE SET title = excluded.title, source_branch = excluded.source_branch, status = excluded.status, web_url = excluded.web_url`,
              pr.id,
              app.id,
              pr.title,
              pr.sourceBranch,
              pr.status,
              pr.webUrl,
            );
            publish(app.id, runId, 'pr.updated', { ...pr });
            notify(app.id, runId, { level: 'info', title: `Pull request #${pr.id} opened`, message: pr.title, link: pr.webUrl });
            await audit({
              action: 'pr.opened',
              via: 'agent',
              appId: app.id,
              target: String(pr.id),
              detail: { runId, branch: pr.sourceBranch, url: pr.webUrl },
            });
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
            await run('UPDATE pull_requests SET status = ? WHERE app_id = ? AND id = ?', pr.status, app.id, id);
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
            await gitProvider().commentOnPullRequest(repoOf(app), id, AGENT_COMMENT_MARK + content);
            return ok('Comment posted.');
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'enable_ci',
        `After you have committed the CI definition (${gitProvider().ciFile}) to main via a merged PR (or on your branch), make it a required check on main. Call once per repository.`,
        { yamlPath: z.string().default(gitProvider().ciFile) },
        async ({ yamlPath }) => {
          try {
            const msg = await gitProvider().enableBuildValidation(repoOf(app), yamlPath);
            publish(app.id, runId, 'activity', { kind: 'ci', title: 'CI enabled', detail: msg });
            await audit({ action: 'ci.enabled', via: 'agent', appId: app.id, target: yamlPath, detail: { runId } });
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
          envSlug: z
            .string()
            .regex(/^[a-z0-9-]{1,20}$/)
            .describe('Short id, e.g. "main", "pr-12", "feat-auth". Reusing a slug redeploys that environment.'),
          branch: z.string().describe('Branch that has been pushed to origin'),
          port: z.number().int().default(8080),
          healthPath: z.string().default('/'),
          dockerfile: z.string().default('Dockerfile'),
          contextSubPath: z.string().optional().describe('Sub-directory used as build context (monorepos)'),
          env: z.record(z.string(), z.string()).default({}).describe('Non-secret runtime environment variables'),
          addons: z.array(z.enum(['postgres', 'redis'])).default([]),
        },
        async (a) => {
          try {
            const spec = {
              port: a.port,
              healthPath: a.healthPath,
              dockerfile: a.dockerfile,
              contextSubPath: a.contextSubPath,
              env: a.env,
              addons: a.addons as Addon[],
            };
            const { res, injected, warning } = await deployEnvironment({
              app,
              runId,
              workspace: ctx.workspace,
              envSlug: a.envSlug,
              branch: a.branch,
              spec,
              via: 'agent',
            });
            return ok(
              [
                'Environment ready.',
                `URL: ${res.url}`,
                injected.length ? `User-configured variables injected (values hidden): ${injected.join(', ')}` : '',
                `Namespace: ${res.namespace}`,
                `Image: ${res.image}`,
                `Expires: ${res.expiresAt}`,
                warning ? `WARNING: ${warning}` : '',
                `Verify it responds (e.g. curl -sf ${res.url}${a.healthPath}) before telling the user it works.`,
              ]
                .filter(Boolean)
                .join('\n'),
            );
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool('environment_status', 'Get pod status and recent warning events of a test environment.', { envSlug: z.string() }, async ({ envSlug }) => {
        try {
          const k = kube();
          const { namespace, url } = k.names(app.slug, envSlug);
          return ok({ url, ...(await k.status(namespace)) });
        } catch (err) {
          return fail(err);
        }
      }),

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

      tool('delete_environment', 'Tear down a test environment you no longer need.', { envSlug: z.string() }, async ({ envSlug }) => {
        try {
          const k = kube();
          const { namespace, name } = k.names(app.slug, envSlug);
          await k.destroy(namespace);
          await audit({ action: 'env.deleted', via: 'agent', appId: app.id, target: name, detail: { runId } });
          const row = await one<EnvRow>('SELECT * FROM environments WHERE name = ?', name);
          if (row) publish(app.id, runId, 'env.updated', { env: await upsertEnv({ ...row, status: 'deleted', message: 'Deleted by agent' }) });
          return ok(`Environment ${name} deleted.`);
        } catch (err) {
          return fail(err);
        }
      }),
      ...(portAgentToolsEnabled() ? portAgentTools() : []),
    ]
      .filter((t) => config.K8S_ENABLED || !K8S_TOOLS.has(t.name))
      .map((t) => ({
        ...t,
        handler: (args: Parameters<typeof t.handler>[0], extra: unknown) =>
          withSpan(
            `tool ${t.name}`,
            { 'blackbox.tool': t.name, 'blackbox.app_id': app.id, 'blackbox.run_id': runId },
            async (span) => {
              const res = await t.handler(args as never, extra);
              if ((res as ToolResult).isError) span.setStatus({ code: SpanStatusCode.ERROR, message: 'tool returned an error' });
              return res;
            },
            ctx.span,
          ),
      })),
  });
}
