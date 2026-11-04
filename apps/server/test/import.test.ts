import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@anthropic-ai/claude-agent-sdk', () => import('./fake-sdk.js'));
const { sdk, init, result, until } = await import('./fake-sdk.js');
const { createUser } = await import('../src/auth.js');
const { createApplication } = await import('../src/applications.js');
const { startScheduler } = await import('../src/agent/runner.js');
const { deleteApplication } = await import('../src/lifecycle.js');
const { one } = await import('../src/db.js');
type AppRow = import('../src/db.js').AppRow;

function sourceRepo(branch: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, 'server.py'), 'print("legacy app")\n');
  git('add', '.');
  git('-c', 'user.name=T', '-c', 'user.email=t@x.io', 'commit', '-q', '-m', 'legacy');
  return dir;
}
const appRow = async (id: string) => (await one<AppRow>('SELECT * FROM applications WHERE id = ?', id))!;

describe('import an existing repository', () => {
  it('protects main, briefs the planner, and never deletes the source', async () => {
    sdk.script = async function* () {
      yield init('s');
      yield result();
    };
    await startScheduler();
    const u = await createUser('imp@x.io', 'I', 'password1');
    const src = sourceRepo('main');
    const app = await createApplication(u.id, { name: 'Legacy', description: '', prompt: 'add a health endpoint', importFrom: src });
    await until(() => sdk.calls.length > 0);
    expect(sdk.calls[0]!.prompts[0]).toMatch(/EXISTING repository[\s\S]*add a health endpoint/);

    const row = await appRow(app.id);
    expect(row.repo_source).toBe(src);
    expect(execFileSync('git', ['--git-dir', row.repo_clone_url!, 'show', 'main:server.py']).toString()).toContain('legacy app');
    // main of the imported copy is protected like any Blackbox repository
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    execFileSync('git', ['clone', '-q', row.repo_clone_url!, ws]);
    fs.writeFileSync(path.join(ws, 'x'), 'x');
    execFileSync('git', ['-C', ws, 'add', 'x']);
    execFileSync('git', ['-C', ws, '-c', 'user.name=T', '-c', 'user.email=t@x.io', 'commit', '-q', '-m', 'x']);
    expect(() => execFileSync('git', ['-C', ws, 'push', '-q', 'origin', 'main'], { stdio: 'pipe' })).toThrow(/TF402455/);

    await deleteApplication(row, u);
    expect(fs.existsSync(path.join(src, '.git'))).toBe(true);
  });

  it('refuses a repository without main', async () => {
    const u = await createUser('imp2@x.io', 'I', 'password1');
    const app = await createApplication(u.id, { name: 'Old', description: '', prompt: 'x', importFrom: sourceRepo('master') });
    await until(async () => (await appRow(app.id)).status === 'error');
    expect((await appRow(app.id)).last_error).toMatch(/no `main` branch/);
  });
});
