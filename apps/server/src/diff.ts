import type { AppRow } from './db.js';
import { exec } from './providers/git.js';
import { prepareWorkspace } from './agent/runner.js';

/** What a branch changes compared to main (the PR's diff), for people who do not use Azure DevOps. */
export type { FileDiff } from '@blackbox/shared';
import type { BranchDiff, FileDiff } from '@blackbox/shared';

const MAX_PATCH = 200_000; // per response

export function parseDiff(numstat: string, patch: string): { files: FileDiff[]; truncated: boolean } {
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [add, del, ...rest] = line.split('\t');
    stats.set(rest.join('\t'), { additions: Number(add) || 0, deletions: Number(del) || 0, binary: add === '-' });
  }
  const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  let budget = MAX_PATCH;
  let truncated = false;
  const files = chunks.map((c) => {
    const path = /^\+\+\+ b\/(.+)$/m.exec(c)?.[1] ?? /^diff --git a\/.+ b\/(.+)$/m.exec(c)?.[1] ?? '?';
    const s = stats.get(path) ?? { additions: 0, deletions: 0, binary: /^Binary files/m.test(c) };
    const keep = c.length <= budget;
    if (!keep) truncated = true;
    budget -= keep ? c.length : 0;
    return { path, ...s, patch: keep ? c : '' };
  });
  return { files, truncated };
}

export async function branchDiff(app: AppRow, branch: string): Promise<BranchDiff> {
  if (!/^[\w./-]+$/.test(branch) || branch.includes('..')) throw Object.assign(new Error('Invalid branch name'), { statusCode: 400 });
  const ws = await prepareWorkspace(app);
  await exec('git', ['-C', ws, 'fetch', '-q', 'origin', 'main', branch]).catch(() => {
    throw Object.assign(new Error(`Branch ${branch} is not on the repository (anymore).`), { statusCode: 404 });
  });
  const range = `origin/main...origin/${branch}`;
  const opts = { maxBuffer: 64 * 1024 * 1024 };
  const [numstat, patch] = await Promise.all([
    exec('git', ['-C', ws, 'diff', '--no-color', '--numstat', range], opts),
    exec('git', ['-C', ws, 'diff', '--no-color', range], opts),
  ]);
  return { branch, ...parseDiff(numstat.stdout, patch.stdout) };
}
