import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('@anthropic-ai/claude-agent-sdk', () => import('./fake-sdk.js'));
const { sdk, init, result, until } = await import('./fake-sdk.js');
const { listTemplates, templateFiles } = await import('../src/templates.js');
const { createUser } = await import('../src/auth.js');
const { createApplication } = await import('../src/applications.js');
const { startScheduler } = await import('../src/agent/runner.js');
const { one } = await import('../src/db.js');
type AppRow = import('../src/db.js').AppRow;

describe('application templates', () => {
  it('lists the starters, each with a Dockerfile, CI and a health endpoint', () => {
    const ids = listTemplates().map((t) => t.id);
    expect(ids.sort()).toEqual(['dotnet-api', 'node-api', 'python-fastapi', 'react-spa']);
    for (const t of listTemplates()) {
      const files = templateFiles(t.id, { name: 'Shop', slug: 'shop' });
      expect(Object.keys(files)).toEqual(expect.arrayContaining(['Dockerfile', 'azure-pipelines.yml']));
      expect(t.healthPath).toBe('/health');
      expect(JSON.stringify(files)).not.toMatch(/\{\{(NAME|SLUG)\}\}/);
    }
  });

  it('seeds the repository and tells the planner', async () => {
    sdk.script = async function* () {
      yield init('s');
      yield result();
    };
    await startScheduler();
    const u = await createUser('tpl@x.io', 'T', 'password1');
    const app = await createApplication(u.id, { name: 'Py Shop', description: '', prompt: 'a shop', template: 'python-fastapi' });
    await until(() => sdk.calls.length > 0);
    expect(sdk.calls[0]!.prompts[0]).toMatch(/from the "Python FastAPI" starter[\s\S]*health endpoint on \/health/);
    const row = (await one<AppRow>('SELECT * FROM applications WHERE id = ?', app.id))!;
    expect(row.template).toBe('python-fastapi');
    const tree = execFileSync('git', ['--git-dir', row.repo_clone_url!, 'ls-tree', '-r', '--name-only', 'main']).toString().split('\n');
    expect(tree).toEqual(expect.arrayContaining(['README.md', 'Dockerfile', 'app/main.py', 'tests/test_main.py', 'azure-pipelines.yml']));
    expect(tree).not.toContain('.github/workflows/ci.yml'); // each provider gets its own CI definition
    expect(execFileSync('git', ['--git-dir', row.repo_clone_url!, 'show', 'main:app/main.py']).toString()).toContain('FastAPI(title="Py Shop")');
  });
});
