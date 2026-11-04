import { config } from '../config.js';
import { exec, initialReadme, type GitProvider, type PullRequestInfo, type RepoInfo } from './git.js';

/** Well-known Azure DevOps policy type ids. */
const POLICY = {
  minReviewers: 'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd',
  requiredReviewers: 'fd2167ab-b0be-447a-8ec8-39368250530e',
  commentResolution: 'c6a1889d-b943-4856-b76f-9e46bb6b0df2',
  mergeStrategy: 'fa4e907d-c16b-4a4c-9dfa-4916e5d171ab',
  build: '0609b952-1397-4640-95ec-e00a01b2c241',
} as const;

const API = 'api-version=7.1';
const ZERO = '0000000000000000000000000000000000000000';

const basic = (pat: string) => 'Basic ' + Buffer.from(`:${pat}`).toString('base64');

export class AzureDevOpsProvider implements GitProvider {
  readonly kind = 'azure-devops' as const;
  readonly ciFile = 'azure-pipelines.yml';
  private org: string;
  private project: string;
  private adminPat: string;
  private agentPat: string;
  private projectId?: string;

  constructor() {
    const { ADO_ORG_URL, ADO_PROJECT, ADO_ADMIN_PAT, ADO_AGENT_GIT_PAT } = config;
    if (!ADO_ORG_URL || !ADO_PROJECT || !ADO_ADMIN_PAT || !ADO_AGENT_GIT_PAT) {
      throw new Error('GIT_PROVIDER=azure-devops requires ADO_ORG_URL, ADO_PROJECT, ADO_ADMIN_PAT and ADO_AGENT_GIT_PAT');
    }
    this.org = ADO_ORG_URL.replace(/\/$/, '');
    this.project = ADO_PROJECT;
    this.adminPat = ADO_ADMIN_PAT;
    this.agentPat = ADO_AGENT_GIT_PAT;
  }

  private async api<T>(method: string, pathAndQuery: string, body?: unknown): Promise<T> {
    const version = pathAndQuery.includes('api-version=') ? '' : `${pathAndQuery.includes('?') ? '&' : '?'}${API}`;
    const url = `${this.org}/${encodeURIComponent(this.project)}/_apis/${pathAndQuery}${version}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: basic(this.adminPat), 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Azure DevOps ${method} ${pathAndQuery} → ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async getProjectId() {
    if (!this.projectId) {
      const res = await fetch(`${this.org}/_apis/projects/${encodeURIComponent(this.project)}?${API}`, {
        headers: { authorization: basic(this.adminPat) },
      });
      if (!res.ok) throw new Error(`Cannot read ADO project ${this.project}: ${res.status} ${await res.text()}`);
      this.projectId = ((await res.json()) as { id: string }).id;
    }
    return this.projectId;
  }

  private identities = new Map<string, Promise<string | null>>();

  /** Entra user (email / UPN) → Azure DevOps identity id, via the org's identity service (cached; null if unknown). */
  identityId(email: string): Promise<string | null> {
    const key = email.toLowerCase();
    let id = this.identities.get(key);
    if (!id) {
      const vssps = this.org.replace('://dev.azure.com/', '://vssps.dev.azure.com/');
      id = fetch(`${vssps}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(key)}&queryMembership=None&${API}`, {
        headers: { authorization: basic(this.adminPat), accept: 'application/json' },
      })
        .then(async (res) => (res.ok ? (((await res.json()) as { value?: { id: string }[] }).value?.[0]?.id ?? null) : null))
        .catch(() => null); // unknown identity: the PR is created without that reviewer
      this.identities.set(key, id);
    }
    return id;
  }

  async deleteRepository(repo: RepoInfo) {
    // Goes to the project's recycle bin (restorable for 30 days by a project admin).
    await this.api('DELETE', `git/repositories/${repo.repoId}`);
  }

  async ping() {
    this.projectId = undefined; // re-check credentials and project access every time
    await this.getProjectId();
  }

  describePolicies() {
    const p = [
      `Minimum ${config.ADO_MIN_REVIEWERS} approving reviewer(s) on main; the PR author's vote does not count; votes reset on new pushes`,
      'All PR comments must be resolved before completion',
      'Squash merge only',
      'Direct pushes to main are rejected (TF402455) — changes must go through a pull request',
    ];
    if (config.ADO_REQUIRED_REVIEWER_ID) p.push('A designated reviewer/group must approve');
    if (config.ADO_BUILD_VALIDATION) p.push('Build validation (azure-pipelines.yml) required once CI is enabled');
    return p;
  }

  async createRepository(input: { slug: string; name: string; description: string; files?: Record<string, string> }): Promise<RepoInfo> {
    const projectId = await this.getProjectId();
    const repo = await this.api<{ id: string; name: string; remoteUrl: string; webUrl: string }>('POST', 'git/repositories', {
      name: input.slug,
      project: { id: projectId },
    });

    // Initial commit so main exists and the agent can branch from it.
    await this.api('POST', `git/repositories/${repo.id}/pushes`, {
      refUpdates: [{ name: 'refs/heads/main', oldObjectId: ZERO }],
      commits: [
        {
          comment: 'Initial commit',
          changes: [
            {
              changeType: 'add',
              item: { path: '/README.md' },
              newContent: { content: initialReadme(input.name, input.description), contentType: 'rawtext' },
            },
            ...Object.entries(input.files ?? {}).map(([rel, content]) => ({
              changeType: 'add',
              item: { path: `/${rel}` },
              newContent: { content, contentType: 'rawtext' },
            })),
          ],
        },
      ],
    });
    await this.api('PATCH', `git/repositories/${repo.id}`, { defaultBranch: 'refs/heads/main' });
    await this.applyMainPolicies(repo.id);

    return { repoId: repo.id, name: repo.name, webUrl: repo.webUrl, cloneUrl: repo.remoteUrl };
  }

  /** `source`: repository name, or its web/clone URL (…/_git/<name>), in ADO_PROJECT. */
  async importRepository(input: { slug: string; source: string }): Promise<RepoInfo> {
    const name = decodeURIComponent(input.source.includes('/_git/') ? input.source.split('/_git/')[1]!.split(/[/?#]/)[0]! : input.source.trim());
    const repo = await this.api<{ id: string; name: string; remoteUrl: string; webUrl: string }>('GET', `git/repositories/${encodeURIComponent(name)}`);
    const main = await this.api<{ value: unknown[] }>('GET', `git/repositories/${repo.id}/refs?filter=heads/main`);
    if (!main.value.length) throw new Error(`Repository ${repo.name} has no main branch: Blackbox works on main + pull requests.`);
    const existing = await this.api<{ count: number }>('GET', `policy/configurations?repositoryId=${repo.id}&refName=refs/heads/main`);
    if (!existing.count) await this.applyMainPolicies(repo.id); // keep the team's own policies when it has some
    return { repoId: repo.id, name: repo.name, webUrl: repo.webUrl, cloneUrl: repo.remoteUrl };
  }

  private scope(repoId: string) {
    return [{ repositoryId: repoId, refName: 'refs/heads/main', matchKind: 'exact' }];
  }

  private async policy(typeId: string, settings: Record<string, unknown>) {
    await this.api('POST', 'policy/configurations', {
      isEnabled: true,
      isBlocking: true,
      type: { id: typeId },
      settings,
    });
  }

  private async applyMainPolicies(repoId: string) {
    const scope = this.scope(repoId);
    await this.policy(POLICY.minReviewers, {
      minimumApproverCount: config.ADO_MIN_REVIEWERS,
      creatorVoteCounts: false,
      allowDownvotes: false,
      resetOnSourcePush: true,
      scope,
    });
    await this.policy(POLICY.commentResolution, { scope });
    await this.policy(POLICY.mergeStrategy, {
      allowSquash: true,
      allowNoFastForward: false,
      allowRebase: false,
      allowRebaseMerge: false,
      scope,
    });
    if (config.ADO_REQUIRED_REVIEWER_ID) {
      await this.policy(POLICY.requiredReviewers, {
        requiredReviewerIds: [config.ADO_REQUIRED_REVIEWER_ID],
        minimumApproverCount: 1,
        creatorVoteCounts: false,
        scope,
      });
    }
  }

  async configureWorkingCopy(dir: string, repo: RepoInfo) {
    // The agent identity only: scoped PAT, no "bypass policies" permission → main stays protected server-side.
    const host = new URL(repo.cloneUrl).origin;
    await exec('git', ['-C', dir, 'config', `http.${host}/.extraheader`, `AUTHORIZATION: ${basic(this.agentPat)}`]);
  }

  async createPullRequest(repo: RepoInfo, pr: { sourceBranch: string; targetBranch?: string; title: string; description: string; reviewerEmails?: string[] }) {
    const ref = (b: string) => (b.startsWith('refs/') ? b : `refs/heads/${b}`);
    const reviewers = (await Promise.all((pr.reviewerEmails ?? []).map((e) => this.identityId(e)))).filter((id): id is string => Boolean(id));
    const created = await this.api<{ pullRequestId: number }>('POST', `git/repositories/${repo.repoId}/pullrequests`, {
      sourceRefName: ref(pr.sourceBranch),
      targetRefName: ref(pr.targetBranch ?? 'main'),
      title: pr.title,
      description: pr.description.slice(0, 4000),
      reviewers: [...new Set(reviewers)].map((id) => ({ id, isRequired: false })),
    });
    return this.getPullRequest(repo, created.pullRequestId);
  }

  async getPullRequest(repo: RepoInfo, id: number): Promise<PullRequestInfo> {
    const projectId = await this.getProjectId();
    const pr = await this.api<{
      pullRequestId: number;
      title: string;
      status: string;
      mergeStatus?: string;
      sourceRefName: string;
      targetRefName: string;
      reviewers?: { displayName: string; vote: number }[];
    }>('GET', `git/repositories/${repo.repoId}/pullrequests/${id}`);

    const threads = await this.api<{
      value: {
        status?: string;
        isDeleted?: boolean;
        threadContext?: { filePath?: string };
        comments: { author: { displayName: string }; content?: string; commentType: string }[];
      }[];
    }>('GET', `git/repositories/${repo.repoId}/pullrequests/${id}/threads`);

    let policies: PullRequestInfo['policies'] = [];
    try {
      const artifactId = encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${id}`);
      const evals = await this.api<{ value: { status: string; configuration: { type: { displayName: string }; settings?: { displayName?: string } } }[] }>(
        'GET',
        `policy/evaluations?artifactId=${artifactId}&api-version=7.1-preview.1`,
      );
      policies = evals.value.map((e) => ({ name: e.configuration.settings?.displayName ?? e.configuration.type.displayName, status: e.status }));
    } catch {
      /* evaluations endpoint is preview; ignore if unavailable */
    }

    return {
      id: pr.pullRequestId,
      title: pr.title,
      status: pr.status,
      mergeStatus: pr.mergeStatus,
      sourceBranch: pr.sourceRefName.replace('refs/heads/', ''),
      targetBranch: pr.targetRefName.replace('refs/heads/', ''),
      webUrl: `${repo.webUrl}/pullrequest/${pr.pullRequestId}`,
      reviewers: (pr.reviewers ?? []).map((r) => ({ name: r.displayName, vote: r.vote })),
      policies,
      comments: threads.value
        .filter((t) => !t.isDeleted)
        .flatMap((t) =>
          t.comments
            .filter((c) => c.commentType === 'text' && c.content)
            .map((c) => ({ author: c.author.displayName, content: c.content!, filePath: t.threadContext?.filePath, status: t.status })),
        ),
    };
  }

  async commentOnPullRequest(repo: RepoInfo, id: number, content: string) {
    await this.api('POST', `git/repositories/${repo.repoId}/pullrequests/${id}/threads`, {
      comments: [{ parentCommentId: 0, content, commentType: 1 }],
      status: 1,
    });
  }

  async enableBuildValidation(repo: RepoInfo, yamlPath: string) {
    if (!config.ADO_BUILD_VALIDATION) return 'Build validation is disabled by the platform configuration.';
    const pipeline = await this.api<{ id: number; name: string }>('POST', 'pipelines', {
      name: `${repo.name}-ci`,
      folder: '\\blackbox',
      configuration: {
        type: 'yaml',
        path: yamlPath.startsWith('/') ? yamlPath : `/${yamlPath}`,
        repository: { id: repo.repoId, name: repo.name, type: 'azureReposGit' },
      },
    });
    await this.policy(POLICY.build, {
      buildDefinitionId: pipeline.id,
      displayName: 'CI',
      manualQueueOnly: false,
      queueOnSourceUpdateOnly: false,
      validDuration: 720,
      scope: this.scope(repo.repoId),
    });
    return `Pipeline "${pipeline.name}" (#${pipeline.id}) created and required as build validation on main.`;
  }

  buildContext(repo: RepoInfo, branch: string) {
    // Kaniko git context: git://host/path#refs/heads/branch, credentials via GIT_USERNAME / GIT_PASSWORD.
    const u = new URL(repo.cloneUrl);
    return {
      context: `git://${u.host}${u.pathname}#refs/heads/${branch}`,
      username: 'blackbox',
      password: this.agentPat,
    };
  }
}
