import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { all, one, run, withLock, type AppRow, type EnvRow, type PullRequestRow } from '../db.js';
import { publish } from '../events.js';
import { AGENT_COMMENT_MARK, gitProvider, type PullRequestInfo, type RepoInfo } from '../providers/git.js';
import { prepareWorkspace, queueSystemRun } from '../agent/runner.js';
import { promoteToStaging, STAGING } from '../environments.js';
import { kube } from '../providers/kubernetes.js';

/**
 * Review loop without the user in the middle: open pull requests are polled; new reviewer comments or a newly
 * failing check (e.g. the CI build) queue a run asking the agent to address them on the same branch.
 * The agent's own PR comments carry AGENT_COMMENT_MARK and never trigger it.
 */

const LOCK = 726203;
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

interface Seen {
  comments: string[];
  failing: string[];
}

const FAILED = new Set(['rejected', 'failed', 'broken']);

/** What changed since last time: new human comments, newly failing checks. */
export function newFeedback(pr: PullRequestInfo, seen: Seen) {
  const comments = (pr.comments ?? []).filter((c) => !c.content.startsWith(AGENT_COMMENT_MARK) && c.status !== 'fixed' && c.status !== 'closed');
  const fresh = comments.filter((c) => !seen.comments.includes(hash(`${c.author}\n${c.filePath ?? ''}\n${c.content}`)));
  const failing = (pr.policies ?? []).filter((p) => FAILED.has(p.status)).map((p) => p.name);
  const newlyFailing = failing.filter((f) => !seen.failing.includes(f));
  return {
    fresh,
    newlyFailing,
    next: { comments: comments.map((c) => hash(`${c.author}\n${c.filePath ?? ''}\n${c.content}`)), failing } satisfies Seen,
  };
}

export function feedbackPrompt(pr: PullRequestInfo, fresh: PullRequestInfo['comments'] & object, newlyFailing: string[]) {
  const lines = [`New feedback arrived on pull request #${pr.id} "${pr.title}" (branch ${pr.sourceBranch}).`];
  if (fresh.length) lines.push('', 'Reviewer comments:', ...fresh.map((c) => `- ${c.author}${c.filePath ? ` on ${c.filePath}` : ''}: ${c.content}`));
  if (newlyFailing.length) lines.push('', `Failing checks: ${newlyFailing.join(', ')}. Use get_pull_request and the CI logs to find out why.`);
  lines.push(
    '',
    'Address it on the same branch: have the coder fix it, push, redeploy the preview if relevant, then answer the reviewers with comment_on_pull_request. ' +
      'Tell the user briefly what you changed. If a comment is a question or you disagree, answer it on the PR instead of changing code.',
  );
  return lines.join('\n');
}

/** After a merge, a pinned `staging` environment follows main (the "merge → staging" promotion path). */
async function redeployStaging(appId: string) {
  if (!config.K8S_ENABLED) return;
  const app = await one<AppRow>('SELECT * FROM applications WHERE id = ?', appId);
  if (!app) return;
  const staging = await one<EnvRow>(
    "SELECT * FROM environments WHERE app_id = ? AND name = ? AND status != 'deleted' AND spec IS NOT NULL",
    appId,
    kube().names(app.slug, STAGING).name,
  );
  if (!staging) return;
  await promoteToStaging(app, await prepareWorkspace(app), staging, 'system', null).catch((err) => console.warn('[staging] redeploy failed', err));
}

export async function pollPullRequests() {
  return withLock(LOCK, async () => {
    const prs = await all<PullRequestRow & { feedback_seen: string | null } & Pick<AppRow, 'repo_id' | 'repo_name' | 'repo_web_url' | 'repo_clone_url'>>(
      `SELECT p.*, a.repo_id, a.repo_name, a.repo_web_url, a.repo_clone_url FROM pull_requests p JOIN applications a ON a.id = p.app_id
       WHERE p.status = 'active' AND a.status != 'archived' AND a.repo_id IS NOT NULL`,
    );
    let triggered = 0;
    for (const row of prs) {
      const repo: RepoInfo = { repoId: row.repo_id!, name: row.repo_name!, webUrl: row.repo_web_url!, cloneUrl: row.repo_clone_url! };
      let pr: PullRequestInfo;
      try {
        pr = await gitProvider().getPullRequest(repo, row.id);
      } catch {
        continue; // provider hiccup or PR gone: next poll
      }
      const first = row.feedback_seen === null; // first look: remember the current state, react only to what comes next
      const seen: Seen = row.feedback_seen ? JSON.parse(row.feedback_seen) : { comments: [], failing: [] };
      const { fresh, newlyFailing, next } = newFeedback(pr, seen);
      await run('UPDATE pull_requests SET status = ?, feedback_seen = ? WHERE app_id = ? AND id = ?', pr.status, JSON.stringify(next), row.app_id, row.id);
      if (pr.status !== row.status) {
        publish(row.app_id, null, 'pr.updated', { ...pr });
        if (pr.status === 'completed') void redeployStaging(row.app_id);
      }
      if (first || pr.status !== 'active' || (!fresh.length && !newlyFailing.length)) continue;
      const what = [
        fresh.length ? `${fresh.length} new review comment${fresh.length > 1 ? 's' : ''}` : '',
        newlyFailing.length ? `failing check: ${newlyFailing.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' and ');
      const queued = await queueSystemRun(
        row.app_id,
        feedbackPrompt(pr, fresh, newlyFailing),
        `Pull request #${pr.id} has ${what}. The agent is addressing it.`,
      );
      if (queued) triggered++;
    }
    return triggered;
  });
}

export function startPrFeedback(log: { warn: (o: object, m: string) => void }) {
  if (!config.PR_FEEDBACK_POLL_SECONDS) return;
  setInterval(() => void pollPullRequests().catch((err) => log.warn({ err }, 'PR feedback poll failed')), config.PR_FEEDBACK_POLL_SECONDS * 1000).unref();
}
