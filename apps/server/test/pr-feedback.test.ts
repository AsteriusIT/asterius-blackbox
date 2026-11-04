import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('@anthropic-ai/claude-agent-sdk', () => import('./fake-sdk.js'));
const { sdk, init, say, result, until } = await import('./fake-sdk.js');
const { createUser } = await import('../src/auth.js');
const { createApplication } = await import('../src/applications.js');
const { startScheduler } = await import('../src/agent/runner.js');
const { pollPullRequests } = await import('../src/integrations/pr-feedback.js');
const { gitProvider } = await import('../src/providers/git.js');
const { all, one } = await import('../src/db.js');
type AppRow = import('../src/db.js').AppRow;

describe('PR review loop', () => {
  it('queues a run for new reviewer comments and failing checks, once', async () => {
    sdk.script = async function* (text, { tools, cwd }) {
      yield init('s');
      if (/A new application/.test(text)) {
        const git = (...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' });
        git('checkout', '-q', '-B', 'feature/x', 'origin/main');
        fs.writeFileSync(path.join(cwd, 'x.txt'), 'x\n');
        git('add', 'x.txt');
        git('commit', '-q', '-m', 'x');
        git('push', '-q', 'origin', 'feature/x');
        await tools.find((t) => t.name === 'create_pull_request')!.handler({ sourceBranch: 'feature/x', title: 'X', description: 'd' });
      } else {
        await tools.find((t) => t.name === 'comment_on_pull_request')!.handler({ id: 1, content: 'Done, renamed.' });
      }
      yield say('ok');
      yield result();
    };
    await startScheduler();
    const u = await createUser('rev@x.io', 'R', 'password1');
    const app = await createApplication(u.id, { name: 'Reviewed', description: '', prompt: 'go' });
    const idle = async () => (await all("SELECT 1 FROM runs WHERE app_id = ? AND status IN ('queued', 'running')", app.id)).length === 0;
    await until(async () => (await idle()) && sdk.calls.length === 1);

    const row = (await one<AppRow>('SELECT * FROM applications WHERE id = ?', app.id))!;
    const repo = { repoId: row.repo_id!, name: row.repo_name!, webUrl: row.repo_web_url!, cloneUrl: row.repo_clone_url! };
    const pr = await gitProvider().getPullRequest(repo, 1);

    expect(await pollPullRequests()).toBe(0); // nothing new
    pr.comments!.push({ author: 'Rita Reviewer', content: 'Please rename the button to "Borrow"', filePath: '/x.txt' });
    expect(await pollPullRequests()).toBe(1);
    await until(async () => (await idle()) && sdk.calls.length === 2);
    expect(sdk.calls[1]!.prompts[0]).toMatch(/pull request #1[\s\S]*Rita Reviewer on \/x\.txt: Please rename the button/);

    // the agent's own reply (marked) and already-seen comments do not trigger again
    expect(pr.comments!.at(-1)!.content).toMatch(/^🤖 \*\*Blackbox agent\*\* — Done, renamed\./);
    expect(await pollPullRequests()).toBe(0);

    // a failing check does
    pr.policies = [{ name: 'CI', status: 'rejected' }];
    expect(await pollPullRequests()).toBe(1);
    await until(async () => (await idle()) && sdk.calls.length === 3);
    expect(sdk.calls[2]!.prompts[0]).toMatch(/Failing checks: CI/);
    const notes = (await all<{ content: string }>("SELECT content FROM messages WHERE app_id = ? AND role = 'system'", app.id)).map((m) => m.content);
    expect(notes).toEqual([expect.stringMatching(/1 new review comment/), expect.stringMatching(/failing check: CI/)]);
  });
});
