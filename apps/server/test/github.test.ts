import { describe, expect, it, vi } from 'vitest';

Object.assign(process.env, { GITHUB_OWNER: 'acme', GITHUB_ADMIN_TOKEN: 'admin', GITHUB_AGENT_TOKEN: 'agent', GITHUB_MIN_REVIEWERS: '2' });
const { GitHubProvider } = await import('../src/providers/github.js');

type Call = { method: string; path: string; body?: Record<string, unknown> };

function mockGitHub(routes: Record<string, (c: Call) => unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const call: Call = { method: init?.method ?? 'GET', path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer admin');
      const key = Object.keys(routes).find((k) => `${call.method} ${call.path}`.startsWith(k));
      if (!key) return new Response('{"message":"Not Found"}', { status: 404 });
      return new Response(JSON.stringify(routes[key]!(call) ?? {}), { status: 200 });
    }),
  );
  return calls;
}
const repoJson = { id: 42, name: 'shop', html_url: 'https://github.com/acme/shop', clone_url: 'https://github.com/acme/shop.git' };

describe('GitHub provider', () => {
  it('creates a protected repository with the starter files', async () => {
    const calls = mockGitHub({
      'GET /users/acme': () => ({ type: 'Organization' }),
      'POST /orgs/acme/repos': () => repoJson,
      'PUT /repos/acme/shop/contents/README.md': () => ({ commit: { sha: 'c1', tree: { sha: 't1' } } }),
      'POST /repos/acme/shop/git/trees': () => ({ sha: 't2' }),
      'POST /repos/acme/shop/git/commits': () => ({ sha: 'c2' }),
      'PATCH /repos/acme/shop/git/refs/heads/main': () => ({}),
      'POST /repos/acme/shop/rulesets': () => ({ id: 7 }),
    });
    const repo = await new GitHubProvider().createRepository({ slug: 'shop', name: 'Shop', description: 'd', files: { Dockerfile: 'FROM x' } });
    expect(repo).toEqual({ repoId: '42', name: 'shop', webUrl: 'https://github.com/acme/shop', cloneUrl: 'https://github.com/acme/shop.git' });
    expect(calls.find((c) => c.path.endsWith('/git/commits'))!.body).toMatchObject({ tree: 't2', parents: ['c1'] });
    const ruleset = calls.find((c) => c.path.endsWith('/rulesets'))!.body!;
    expect(ruleset).toMatchObject({ target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['refs/heads/main'] } } });
    expect((ruleset.rules as { type: string; parameters?: Record<string, unknown> }[]).find((r) => r.type === 'pull_request')!.parameters).toMatchObject({
      required_approving_review_count: 2,
      required_review_thread_resolution: true,
      allowed_merge_methods: ['squash'],
    });
    vi.unstubAllGlobals();
  });

  it('maps pull requests: merged status, reviews, failing checks and comments', async () => {
    mockGitHub({
      'GET /repos/acme/shop/pulls/5/reviews': () => [{ user: { login: 'rita' }, state: 'CHANGES_REQUESTED' }],
      'GET /repos/acme/shop/pulls/5/comments': () => [{ user: { login: 'rita' }, body: 'rename this', path: 'src/a.js' }],
      'GET /repos/acme/shop/pulls/5': () => ({
        number: 5,
        title: 'T',
        state: 'closed',
        merged_at: '2026-01-01',
        html_url: 'u',
        head: { ref: 'f', sha: 's' },
        base: { ref: 'main' },
      }),
      'GET /repos/acme/shop/issues/5/comments': () => [{ user: { login: 'bob' }, body: 'nice' }],
      'GET /repos/acme/shop/commits/s/check-runs': () => ({ check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] }),
    });
    const pr = await new GitHubProvider().getPullRequest({ ...repoJson, repoId: '42', webUrl: '', cloneUrl: '' }, 5);
    expect(pr).toMatchObject({ status: 'completed', reviewers: [{ name: 'rita', vote: -10 }], policies: [{ name: 'ci', status: 'rejected' }] });
    expect(pr.comments).toEqual([
      { author: 'rita', content: 'rename this', filePath: 'src/a.js' },
      { author: 'bob', content: 'nice' },
    ]);
    vi.unstubAllGlobals();
  });

  it('requires the ci check and imports repositories, keeping existing rules', async () => {
    const calls = mockGitHub({
      'GET /repos/acme/shop/rulesets': () => [{ id: 7, name: 'blackbox-main' }],
      'PUT /repos/acme/shop/rulesets/7': () => ({}),
      'GET /repos/acme/shop/branches/main': () => ({}),
      'GET /repos/acme/shop': () => repoJson,
    });
    const gh = new GitHubProvider();
    const repo = { repoId: '42', name: 'shop', webUrl: '', cloneUrl: 'https://github.com/acme/shop.git' };
    expect(await gh.enableBuildValidation(repo, '.github/workflows/ci.yml')).toMatch(/required check/);
    const put = calls.find((c) => c.method === 'PUT')!.body!;
    expect(put.rules).toContainEqual({
      type: 'required_status_checks',
      parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'ci' }] },
    });

    calls.length = 0;
    expect(await gh.importRepository({ slug: 'shop', source: 'https://github.com/acme/shop.git' })).toMatchObject({ name: 'shop' });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]); // rules already exist
    expect(gh.buildContext(repo, 'feat')).toEqual({ context: 'git://github.com/acme/shop.git#refs/heads/feat', username: 'x-access-token', password: 'agent' });
    vi.unstubAllGlobals();
  });
});
