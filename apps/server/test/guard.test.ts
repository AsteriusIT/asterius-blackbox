import { describe, expect, it } from 'vitest';
import { checkBash, checkWrite, guardHook, parseGit } from '../src/agent/guard.js';

const allowed = [
  'git push origin feature/login',
  'git push -u origin feature/login',
  'git push --set-upstream origin fix/main-page',
  'git push origin HEAD:feature/main-menu',
  'git -C /ws push origin feature/x',
  'git status && git log --oneline -5',
  'git checkout main && git pull',
  'npm test',
  'echo main',
  'git commit -m "push to main later"',
  'git push origin feature/domain',
];

const denied: [string, RegExp][] = [
  ['git push origin main', /main is protected/],
  ['git push origin HEAD:main', /main is protected/],
  ['git push origin HEAD:refs/heads/main', /main is protected/],
  ['git -c a=b push origin HEAD:refs/heads/main', /main is protected/],
  ['git -c credential.x=y -C . push origin main', /credentials|main is protected/],
  ['FOO=1 git push origin master', /main is protected/],
  ['env GIT_TRACE=1 git push origin main', /main is protected/],
  ['/usr/bin/git push origin main', /main is protected/],
  ['cd /ws; git push origin feature/x:main', /main is protected/],
  ['sh -c "git push origin HEAD:main"', /main is protected/],
  ["bash -c 'git push origin main'", /main is protected/],
  ['git push --force origin feature/x', /Force pushes/],
  ['git push -f origin feature/x', /Force pushes/],
  ['git push -uf origin feature/x', /Force pushes/],
  ['git push --force-with-lease origin feature/x', /Force pushes/],
  ['git push origin +feature/x', /Force pushes/],
  ['git push origin :feature/x', /Force pushes/],
  ['git push --delete origin feature/x', /Force pushes/],
  ['git push --mirror origin', /Force pushes/],
  ['git push --all origin', /Force pushes/],
  ['B=main; git push origin HEAD:$B', /literal/],
  ['git push origin HEAD:`echo main`', /literal|main is protected/],
  ['git config alias.p push', /aliases/],
  ['git -c alias.p=push p origin main', /aliases|main is protected/],
  ['kubectl get pods', /mcp__blackbox__/],
  ['helm list', /mcp__blackbox__/],
  ['az login', /mcp__blackbox__/],
  ['git config --get http.https://dev.azure.com/.extraheader', /credentials/],
  ['cat ~/.git-credentials', /credentials/],
];

describe('checkBash', () => {
  it.each(allowed)('allows %s', (cmd) => expect(checkBash(cmd)).toBeNull());
  it.each(denied)('denies %s', (cmd, reason) => expect(checkBash(cmd)).toMatch(reason));
});

describe('parseGit', () => {
  it('skips env vars, wrappers and global options', () => {
    expect(parseGit('A=1 env git -c x=y -C /tmp --no-pager push origin b')).toEqual({ sub: 'push', args: ['origin', 'b'], configs: ['x=y'] });
  });
  it('returns null for other commands', () => expect(parseGit('npm test')).toBeNull());
});

describe('checkWrite', () => {
  it('allows the workspace', () => {
    expect(checkWrite('src/a.ts', '/ws/app')).toBeNull();
    expect(checkWrite('/ws/app/a.ts', '/ws/app')).toBeNull();
  });
  it('denies outside', () => {
    expect(checkWrite('../other/a.ts', '/ws/app')).toMatch(/only write inside/);
    expect(checkWrite('/ws/app-evil/a.ts', '/ws/app')).toMatch(/only write inside/);
    expect(checkWrite('/etc/passwd', '/ws/app')).toMatch(/only write inside/);
  });
});

describe('guardHook', () => {
  const hook = guardHook('/ws/app');
  const call = (tool_name: string, tool_input: object) =>
    hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: 's', transcript_path: '', cwd: '/ws/app', tool_use_id: 't' } as never, 't', {
      signal: new AbortController().signal,
    });
  it('denies a push to main', async () => {
    const r = (await call('Bash', { command: 'git push origin main' })) as { hookSpecificOutput?: { permissionDecision: string } };
    expect(r.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
  it('denies writes outside the workspace', async () => {
    const r = (await call('Write', { file_path: '/etc/x' })) as { hookSpecificOutput?: { permissionDecision: string } };
    expect(r.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
  it('lets other tools through', async () => expect(await call('Read', { file_path: '/etc/x' })).toEqual({}));
});
