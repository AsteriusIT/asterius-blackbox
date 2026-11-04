import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, paths } from '../config.js';
import { AzureDevOpsProvider } from './azure-devops.js';
import { GitHubProvider } from './github.js';

export const exec = promisify(execFile);

/** Prefix of the agent's own PR comments, so the review loop does not answer itself. */
export const AGENT_COMMENT_MARK = '🤖 **Blackbox agent** — ';

export interface RepoInfo {
  repoId: string;
  name: string;
  webUrl: string;
  cloneUrl: string;
}

export interface PullRequestInfo {
  id: number;
  title: string;
  status: string; // active | completed | abandoned
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  mergeStatus?: string;
  reviewers?: { name: string; vote: number }[];
  policies?: { name: string; status: string }[];
  comments?: { author: string; content: string; filePath?: string; status?: string }[];
}

export interface GitProvider {
  readonly kind: 'azure-devops' | 'github' | 'local';
  /** CI definition the agent adds before calling enable_ci. */
  readonly ciFile: string;
  /** Create the repository, push an initial commit to main and lock main with branch policies. */
  /** `files`: starter content committed next to the README. */
  createRepository(input: { slug: string; name: string; description: string; files?: Record<string, string> }): Promise<RepoInfo>;
  /** Human-readable list of the policies protecting main (shown to the user and to the agent). */
  describePolicies(): string[];
  /** Configure git credentials for the *agent* identity inside a working copy. */
  configureWorkingCopy(dir: string, repo: RepoInfo): Promise<void>;
  /** `reviewerEmails`: people to add as (optional) reviewers, so they are notified by the provider. */
  createPullRequest(
    repo: RepoInfo,
    pr: { sourceBranch: string; targetBranch?: string; title: string; description: string; reviewerEmails?: string[] },
  ): Promise<PullRequestInfo>;
  getPullRequest(repo: RepoInfo, id: number): Promise<PullRequestInfo>;
  commentOnPullRequest(repo: RepoInfo, id: number, content: string): Promise<void>;
  /** Register the repo's pipeline YAML and make it a required build-validation policy on main. */
  enableBuildValidation(repo: RepoInfo, yamlPath: string): Promise<string>;
  /** Use an existing repository (it must have a `main` branch); protect main if it is not protected yet. */
  importRepository(input: { slug: string; source: string }): Promise<RepoInfo>;
  /** Delete the repository (application deletion). */
  deleteRepository(repo: RepoInfo): Promise<void>;
  /** Readiness: the provider's API answers with our credentials. */
  ping(): Promise<void>;
  /** Git context + credentials for an in-cluster image build (Kaniko). */
  buildContext(repo: RepoInfo, branch: string): { context: string; username: string; password: string };
}

/**
 * Offline provider: bare repositories on disk with a pre-receive hook that rejects any update of
 * refs/heads/main (the equivalent of the ADO policies). Lets you try the whole loop without Azure.
 */
class LocalGitProvider implements GitProvider {
  readonly kind = 'local' as const;
  readonly ciFile = 'azure-pipelines.yml';
  private prs = new Map<string, PullRequestInfo[]>();

  describePolicies() {
    return ['Direct pushes to main are rejected (pre-receive hook)', 'Changes reach main only through a pull request merged by a human'];
  }

  async createRepository(input: { slug: string; name: string; description: string; files?: Record<string, string> }): Promise<RepoInfo> {
    const bare = path.join(paths.localRepos, `${input.slug}.git`);
    fs.mkdirSync(bare, { recursive: true });
    await exec('git', ['init', '--bare', '-b', 'main', bare]);
    protectMain(bare);
    // initial commit, pushed by the platform identity
    const tmp = fs.mkdtempSync(path.join(paths.localRepos, '.init-'));
    try {
      await exec('git', ['init', '-b', 'main', tmp]);
      fs.writeFileSync(path.join(tmp, 'README.md'), initialReadme(input.name, input.description));
      for (const [rel, content] of Object.entries(input.files ?? {})) {
        fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
        fs.writeFileSync(path.join(tmp, rel), content);
      }
      await exec('git', ['-C', tmp, 'add', '.']);
      await exec('git', ['-C', tmp, '-c', 'user.name=Blackbox', '-c', 'user.email=blackbox@localhost', 'commit', '-m', 'Initial commit']);
      await exec('git', ['-C', tmp, 'push', bare, 'main'], { env: { ...process.env, BLACKBOX_PLATFORM: '1' } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { repoId: input.slug, name: input.slug, webUrl: `file://${bare}`, cloneUrl: bare };
  }

  /** Local provider: `source` is a git repository on this machine; it is copied (bare) and its main protected. */
  async importRepository(input: { slug: string; source: string }): Promise<RepoInfo> {
    if (!path.isAbsolute(input.source) || !fs.existsSync(input.source)) throw new Error(`${input.source} is not an existing local path`);
    const bare = path.join(paths.localRepos, `${input.slug}.git`);
    await exec('git', ['clone', '-q', '--bare', input.source, bare]);
    try {
      await exec('git', ['--git-dir', bare, 'rev-parse', '--verify', '-q', 'refs/heads/main']);
    } catch {
      fs.rmSync(bare, { recursive: true, force: true });
      throw new Error('The repository has no `main` branch: Blackbox works on main + pull requests.');
    }
    protectMain(bare);
    return { repoId: input.slug, name: input.slug, webUrl: `file://${bare}`, cloneUrl: bare };
  }

  async configureWorkingCopy() {}

  async deleteRepository(repo: RepoInfo) {
    if (repo.cloneUrl.startsWith(paths.localRepos + path.sep)) fs.rmSync(repo.cloneUrl, { recursive: true, force: true });
    this.prs.delete(repo.repoId);
  }

  async ping() {
    fs.mkdirSync(paths.localRepos, { recursive: true });
    fs.accessSync(paths.localRepos, fs.constants.W_OK);
  }

  async createPullRequest(repo: RepoInfo, pr: { sourceBranch: string; targetBranch?: string; title: string; description: string; reviewerEmails?: string[] }) {
    const list = this.prs.get(repo.repoId) ?? [];
    const info: PullRequestInfo = {
      id: list.length + 1,
      title: pr.title,
      status: 'active',
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch ?? 'main',
      webUrl: `${repo.webUrl}#pr-${list.length + 1}`,
      reviewers: (pr.reviewerEmails ?? []).map((name) => ({ name, vote: 0 })),
      policies: [{ name: 'Minimum number of reviewers', status: 'queued' }],
      comments: [],
    };
    list.push(info);
    this.prs.set(repo.repoId, list);
    return info;
  }

  async getPullRequest(repo: RepoInfo, id: number) {
    const pr = this.prs.get(repo.repoId)?.find((p) => p.id === id);
    if (!pr) throw new Error(`PR ${id} not found`);
    return pr;
  }

  async commentOnPullRequest(repo: RepoInfo, id: number, content: string) {
    (await this.getPullRequest(repo, id)).comments?.push({ author: 'agent', content });
  }

  async enableBuildValidation(_repo: RepoInfo, yamlPath: string) {
    return `local provider: build validation for ${yamlPath} is simulated (no CI server).`;
  }

  buildContext(): never {
    throw new Error('In-cluster builds need a reachable git server: set GIT_PROVIDER=azure-devops to deploy environments.');
  }
}

/** The local equivalent of the ADO branch policies: a pre-receive hook rejecting pushes to main. */
function protectMain(bare: string) {
  fs.writeFileSync(
    path.join(bare, 'hooks', 'pre-receive'),
    `#!/bin/sh
# Blackbox branch policy: main is protected.
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ] && [ "$BLACKBOX_PLATFORM" != "1" ]; then
    echo "TF402455: Pushes to this branch are not permitted; you must use a pull request to update this branch." >&2
    exit 1
  fi
done
exit 0
`,
    { mode: 0o755 },
  );
}

export function initialReadme(name: string, description: string) {
  return `# ${name}

${description || '_No description yet._'}

---
This repository is managed by **Asterius AI Blackbox**. \`main\` is protected: every change goes through a pull request.
`;
}

let provider: GitProvider | undefined;
export function gitProvider(): GitProvider {
  if (!provider)
    provider =
      config.GIT_PROVIDER === 'azure-devops' ? new AzureDevOpsProvider() : config.GIT_PROVIDER === 'github' ? new GitHubProvider() : new LocalGitProvider();
  return provider;
}
