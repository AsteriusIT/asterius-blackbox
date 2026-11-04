import { describe, expect, it, vi } from 'vitest';

Object.assign(process.env, { ADO_ORG_URL: 'https://dev.azure.com/acme', ADO_PROJECT: 'Blackbox', ADO_ADMIN_PAT: 'admin', ADO_AGENT_GIT_PAT: 'agent' });
const { AzureDevOpsProvider } = await import('../src/providers/azure-devops.js');

describe('Azure DevOps reviewers', () => {
  it('adds the Entra users it can resolve as PR reviewers', async () => {
    let created: { reviewers?: unknown } = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (u.host === 'vssps.dev.azure.com') return json({ value: u.searchParams.get('filterValue') === 'ana@acme.com' ? [{ id: 'ado-ana' }] : [] });
      if (u.pathname.endsWith('/pullrequests') && init?.method === 'POST') {
        created = JSON.parse(String(init.body));
        return json({ pullRequestId: 7 });
      }
      if (u.pathname.endsWith('/projects/Blackbox')) return json({ id: 'proj' });
      if (u.pathname.endsWith('/threads')) return json({ value: [] });
      if (u.pathname.includes('policy/evaluations')) return json({ value: [] });
      if (u.pathname.endsWith('/pullrequests/7'))
        return json({
          pullRequestId: 7,
          title: 'T',
          status: 'active',
          sourceRefName: 'refs/heads/f',
          targetRefName: 'refs/heads/main',
          reviewers: [{ displayName: 'Ana', vote: 0 }],
        });
      return new Response('not mocked: ' + url, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const ado = new AzureDevOpsProvider();
    const repo = {
      repoId: 'r1',
      name: 'shop',
      webUrl: 'https://dev.azure.com/acme/Blackbox/_git/shop',
      cloneUrl: 'https://acme@dev.azure.com/acme/Blackbox/_git/shop',
    };
    const pr = await ado.createPullRequest(repo, {
      sourceBranch: 'f',
      title: 'T',
      description: 'd',
      reviewerEmails: ['ana@acme.com', 'ghost@acme.com', 'ANA@acme.com'],
    });
    expect(created.reviewers).toEqual([{ id: 'ado-ana', isRequired: false }]);
    expect(pr.reviewers).toEqual([{ name: 'Ana', vote: 0 }]);
    // identities are cached (one lookup per distinct email)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('vssps')).length).toBe(2);
    vi.unstubAllGlobals();
  });

  it('imports a repository by URL and only adds policies when main has none', async () => {
    const calls: string[] = [];
    const policies = { count: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = new URL(url);
        calls.push(`${init?.method ?? 'GET'} ${u.pathname.replace('/acme/Blackbox/_apis/', '')}`);
        const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (u.pathname.endsWith('/git/repositories/legacy-shop'))
          return json({
            id: 'r9',
            name: 'legacy-shop',
            remoteUrl: 'https://acme@dev.azure.com/acme/Blackbox/_git/legacy-shop',
            webUrl: 'https://dev.azure.com/acme/Blackbox/_git/legacy-shop',
          });
        if (u.pathname.endsWith('/refs')) return json({ value: [{ name: 'refs/heads/main' }] });
        if (u.pathname.endsWith('/policy/configurations') && (init?.method ?? 'GET') === 'GET') return json(policies);
        if (u.pathname.endsWith('/policy/configurations')) return json({ id: 1 });
        return new Response('not mocked: ' + url, { status: 500 });
      }),
    );
    const ado = new AzureDevOpsProvider();
    const repo = await ado.importRepository({ slug: 'legacy', source: 'https://dev.azure.com/acme/Blackbox/_git/legacy-shop?path=/README.md' });
    expect(repo).toMatchObject({ repoId: 'r9', name: 'legacy-shop' });
    expect(calls.filter((c) => c === 'POST policy/configurations').length).toBeGreaterThanOrEqual(3);

    calls.length = 0;
    policies.count = 2;
    await ado.importRepository({ slug: 'legacy', source: 'legacy-shop' });
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    vi.unstubAllGlobals();
  });
});
