import { config } from '../config.js';
import { exec, initialReadme, type GitProvider, type PullRequestInfo, type RepoInfo } from './git.js';

/**
 * GitHub provider: repositories under GITHUB_OWNER, main protected by a repository ruleset (pull request with
 * reviews, squash only, resolved conversations, no force-push/deletion), CI with GitHub Actions.
 * Two tokens, like Azure DevOps: GITHUB_ADMIN_TOKEN (platform: repos, rulesets, PRs) and GITHUB_AGENT_TOKEN
 * (the agent's git push: contents read/write only, never a ruleset bypass actor).
 */

const RULESET = 'blackbox-main';
const CI_CHECK = 'ci';

interface GhPull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  mergeable_state?: string;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export class GitHubProvider implements GitProvider {
  readonly kind = 'github' as const;
  readonly ciFile = '.github/workflows/ci.yml';
  private owner: string;
  private api: string;
  private adminToken: string;
  private agentToken: string;
  private ownerIsOrg?: boolean;

  constructor() {
    const { GITHUB_OWNER, GITHUB_ADMIN_TOKEN, GITHUB_AGENT_TOKEN } = config;
    if (!GITHUB_OWNER || !GITHUB_ADMIN_TOKEN || !GITHUB_AGENT_TOKEN)
      throw new Error('GIT_PROVIDER=github requires GITHUB_OWNER, GITHUB_ADMIN_TOKEN and GITHUB_AGENT_TOKEN');
    this.owner = GITHUB_OWNER;
    this.api = config.GITHUB_API_URL.replace(/\/$/, '');
    this.adminToken = GITHUB_ADMIN_TOKEN;
    this.agentToken = GITHUB_AGENT_TOKEN;
  }

  private async gh<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.adminToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`), { status: res.status });
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private repoPath = (name: string) => `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(name)}`;

  describePolicies() {
    return [
      `Pull request required on main with ${config.GITHUB_MIN_REVIEWERS} approving review(s); stale approvals are dismissed on new pushes`,
      'All review conversations must be resolved before merging',
      'Squash merge only; force pushes and deletion of main are blocked (repository ruleset)',
      'Required check "ci" (GitHub Actions) once CI is enabled',
    ];
  }

  private async isOrg() {
    if (this.ownerIsOrg === undefined)
      this.ownerIsOrg = (await this.gh<{ type: string }>('GET', `/users/${encodeURIComponent(this.owner)}`)).type === 'Organization';
    return this.ownerIsOrg;
  }

  private toRepo(r: { id: number; name: string; html_url: string; clone_url: string }): RepoInfo {
    return { repoId: String(r.id), name: r.name, webUrl: r.html_url, cloneUrl: r.clone_url };
  }

  async createRepository(input: { slug: string; name: string; description: string; files?: Record<string, string> }): Promise<RepoInfo> {
    const created = await this.gh<{ id: number; name: string; html_url: string; clone_url: string }>(
      'POST',
      (await this.isOrg()) ? `/orgs/${this.owner}/repos` : '/user/repos',
      {
        name: input.slug,
        description: input.description.slice(0, 300),
        private: true,
        auto_init: false,
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: false,
        delete_branch_on_merge: true,
      },
    );
    const repo = this.repoPath(created.name);
    // First commit through the contents API (creates main), the starter files in one more commit (Git data API).
    const first = await this.gh<{ commit: { sha: string; tree: { sha: string } } }>('PUT', `${repo}/contents/README.md`, {
      message: 'Initial commit',
      content: Buffer.from(initialReadme(input.name, input.description)).toString('base64'),
      branch: 'main',
    });
    const files = Object.entries(input.files ?? {});
    if (files.length) {
      const tree = await this.gh<{ sha: string }>('POST', `${repo}/git/trees`, {
        base_tree: first.commit.tree.sha,
        tree: files.map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
      });
      const commit = await this.gh<{ sha: string }>('POST', `${repo}/git/commits`, { message: 'Starter', tree: tree.sha, parents: [first.commit.sha] });
      await this.gh('PATCH', `${repo}/git/refs/heads/main`, { sha: commit.sha });
    }
    await this.protectMain(created.name);
    return this.toRepo(created);
  }

  async importRepository(input: { slug: string; source: string }): Promise<RepoInfo> {
    const name = input.source
      .trim()
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean)
      .at(-1)!;
    const r = await this.gh<{ id: number; name: string; html_url: string; clone_url: string }>('GET', this.repoPath(name));
    await this.gh('GET', `${this.repoPath(r.name)}/branches/main`).catch(() => {
      throw new Error(`Repository ${r.name} has no main branch: Blackbox works on main + pull requests.`);
    });
    const rulesets = await this.gh<{ name: string }[]>('GET', `${this.repoPath(r.name)}/rulesets`);
    if (!rulesets.length) await this.protectMain(r.name); // keep the team's own rules when it has some
    return this.toRepo(r);
  }

  private ruleset(requiredChecks: string[] = []) {
    return {
      name: RULESET,
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: config.GITHUB_MIN_REVIEWERS,
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: true,
            allowed_merge_methods: ['squash'],
          },
        },
        ...(requiredChecks.length
          ? [
              {
                type: 'required_status_checks',
                parameters: { strict_required_status_checks_policy: false, required_status_checks: requiredChecks.map((context) => ({ context })) },
              },
            ]
          : []),
      ],
    };
  }

  private async protectMain(name: string) {
    await this.gh('POST', `${this.repoPath(name)}/rulesets`, this.ruleset());
  }

  async configureWorkingCopy(dir: string, repo: RepoInfo) {
    const host = new URL(repo.cloneUrl).origin;
    const basic = Buffer.from(`x-access-token:${this.agentToken}`).toString('base64');
    await exec('git', ['-C', dir, 'config', `http.${host}/.extraheader`, `AUTHORIZATION: basic ${basic}`]);
  }

  async createPullRequest(repo: RepoInfo, pr: { sourceBranch: string; targetBranch?: string; title: string; description: string; reviewerEmails?: string[] }) {
    const created = await this.gh<GhPull>('POST', `${this.repoPath(repo.name)}/pulls`, {
      title: pr.title,
      head: pr.sourceBranch,
      base: pr.targetBranch ?? 'main',
      body: pr.description.slice(0, 60_000),
    });
    // GitHub reviewers are logins: resolve the emails people made public on their profile (best effort).
    const logins: string[] = [];
    for (const email of pr.reviewerEmails ?? []) {
      const found = await this.gh<{ items: { login: string }[] }>('GET', `/search/users?q=${encodeURIComponent(`${email} in:email`)}`).catch(() => ({
        items: [],
      }));
      if (found.items[0]) logins.push(found.items[0].login);
    }
    if (logins.length)
      await this.gh('POST', `${this.repoPath(repo.name)}/pulls/${created.number}/requested_reviewers`, { reviewers: logins }).catch(() => undefined);
    return this.getPullRequest(repo, created.number);
  }

  async getPullRequest(repo: RepoInfo, id: number): Promise<PullRequestInfo> {
    const base = `${this.repoPath(repo.name)}`;
    const pr = await this.gh<GhPull>('GET', `${base}/pulls/${id}`);
    const [reviews, reviewComments, comments, checks] = await Promise.all([
      this.gh<{ user: { login: string }; state: string }[]>('GET', `${base}/pulls/${id}/reviews`),
      this.gh<{ user: { login: string }; body: string; path: string }[]>('GET', `${base}/pulls/${id}/comments`),
      this.gh<{ user: { login: string }; body: string }[]>('GET', `${base}/issues/${id}/comments`),
      this.gh<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>('GET', `${base}/commits/${pr.head.sha}/check-runs`).catch(() => ({
        check_runs: [],
      })),
    ]);
    const vote: Record<string, number> = { APPROVED: 10, CHANGES_REQUESTED: -10, COMMENTED: 0 };
    return {
      id: pr.number,
      title: pr.title,
      status: pr.merged_at ? 'completed' : pr.state === 'closed' ? 'abandoned' : 'active',
      mergeStatus: pr.mergeable_state,
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      webUrl: pr.html_url,
      reviewers: reviews.map((r) => ({ name: r.user.login, vote: vote[r.state] ?? 0 })),
      // "rejected" like an Azure DevOps policy, so the review loop treats a red check the same way
      policies: checks.check_runs.map((c) => ({
        name: c.name,
        status:
          c.status !== 'completed'
            ? 'running'
            : c.conclusion === 'success'
              ? 'approved'
              : c.conclusion === 'failure'
                ? 'rejected'
                : (c.conclusion ?? 'unknown'),
      })),
      comments: [
        ...reviewComments.map((c) => ({ author: c.user.login, content: c.body, filePath: c.path })),
        ...comments.map((c) => ({ author: c.user.login, content: c.body })),
      ],
    };
  }

  async commentOnPullRequest(repo: RepoInfo, id: number, content: string) {
    await this.gh('POST', `${this.repoPath(repo.name)}/issues/${id}/comments`, { body: content });
  }

  async enableBuildValidation(repo: RepoInfo, yamlPath: string) {
    if (!config.ADO_BUILD_VALIDATION) return 'Build validation is disabled by the platform configuration.';
    const rulesets = await this.gh<{ id: number; name: string }[]>('GET', `${this.repoPath(repo.name)}/rulesets`);
    const ours = rulesets.find((r) => r.name === RULESET);
    if (ours) await this.gh('PUT', `${this.repoPath(repo.name)}/rulesets/${ours.id}`, this.ruleset([CI_CHECK]));
    else await this.gh('POST', `${this.repoPath(repo.name)}/rulesets`, this.ruleset([CI_CHECK]));
    return `GitHub Actions runs ${yamlPath} on every pull request; its job "${CI_CHECK}" is now a required check on main (name the job \`${CI_CHECK}\`).`;
  }

  buildContext(repo: RepoInfo, branch: string) {
    const u = new URL(repo.cloneUrl);
    return { context: `git://${u.host}${u.pathname}#refs/heads/${branch}`, username: 'x-access-token', password: this.agentToken };
  }

  async deleteRepository(repo: RepoInfo) {
    await this.gh('DELETE', this.repoPath(repo.name));
  }

  async ping() {
    await this.gh('GET', `/users/${encodeURIComponent(this.owner)}`);
  }
}
