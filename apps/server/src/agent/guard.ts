import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

/**
 * PreToolUse guard: fail fast with a helpful message on commands the platform forbids.
 *
 * BEST-EFFORT ONLY. A shell is Turing-complete: a script file, `eval` of computed strings or an
 * interpreter (`python -c`) can always get around string inspection. The real controls are elsewhere:
 *  - server-side branch policies on main (Azure DevOps) / the pre-receive hook (local provider);
 *  - the sandbox `denyRead` on every credential path (DATA_DIR, ~/.kube), see runner.ts;
 *  - the agent's git identity having no "bypass policies" / "force push" permission.
 */

const PROTECTED = new Set(['main', 'master']);
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'sudo', 'xargs', 'builtin', 'nice']);
/** git global options that take a separate value. */
const GIT_OPT_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const FORCE_FLAGS = /^(--force(-with-lease|-if-includes)?(=.*)?|--mirror|--delete|--all|--prune)$/;

const words = (segment: string) =>
  segment
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^[$({`'"]+|['"]+$/g, ''))
    .filter(Boolean);

interface GitCall {
  sub: string;
  args: string[];
  configs: string[];
}

/** Parse one simple command; returns the git sub-command (after env vars, wrappers and global options) or null. */
export function parseGit(segment: string): GitCall | null {
  const t = words(segment);
  let i = 0;
  while (i < t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]!) || WRAPPERS.has(t[i]!))) i++;
  if (path.basename(t[i] ?? '') !== 'git') return null;
  i++;
  const configs: string[] = [];
  while (i < t.length && t[i]!.startsWith('-')) {
    const opt = t[i++]!;
    if (opt === '-c') configs.push(t[i] ?? '');
    else if (opt.startsWith('-c')) configs.push(opt.slice(2));
    if (GIT_OPT_WITH_VALUE.has(opt)) i++;
  }
  return { sub: t[i] ?? '', args: t.slice(i + 1), configs };
}

function checkPush(args: string[]): string | null {
  const flags = args.filter((a) => a.startsWith('-'));
  const positional = args.filter((a) => !a.startsWith('-'));
  if (flags.some((f) => FORCE_FLAGS.test(f) || /^-[a-zA-Z]*[fd]/.test(f)))
    return 'Force pushes, mirror/--all pushes and remote branch deletion are not allowed.';
  for (const ref of positional.slice(1)) {
    if (/[$`]/.test(ref)) return 'Push refspecs must be literal branch names (no variables or substitutions).';
    if (ref.startsWith('+')) return 'Force pushes, mirror/--all pushes and remote branch deletion are not allowed.';
    if (ref.startsWith(':')) return 'Force pushes, mirror/--all pushes and remote branch deletion are not allowed.';
    const dst = (ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref).replace(/^refs\/heads\//, '');
    if (PROTECTED.has(dst)) return 'main is protected by branch policy. Push a feature branch and open a pull request instead.';
  }
  return null;
}

/** Returns a denial reason for a Bash command, or null when it may run. */
export function checkBash(cmd: string): string | null {
  if (/\b(kubectl|helm|az)\b/.test(cmd)) return 'Use the mcp__blackbox__* tools for cluster and Azure operations.';
  if (/extraheader|credential\.helper|\.git-credentials/i.test(cmd)) return 'Do not read or modify git credentials.';

  for (const segment of cmd.split(/&&|\|\||[;|\n&]/)) {
    const g = parseGit(segment);
    if (!g) continue;
    if (g.configs.some((c) => /^alias\./i.test(c)) || (g.sub === 'config' && g.args.some((a) => /^alias\./i.test(a))))
      return 'git aliases are not allowed; run git commands directly.';
    if (g.sub === 'push') {
      const reason = checkPush(g.args);
      if (reason) return reason;
    }
  }
  // Nested shells: `sh -c "git push origin HEAD:main"`, `eval '…'`.
  for (const m of cmd.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    const inner = m[1] ?? m[2] ?? '';
    if (inner && inner !== cmd) {
      const reason = checkBash(inner);
      if (reason) return reason;
    }
  }
  return null;
}

/** Returns a denial reason for a file write outside the workspace, or null. */
export function checkWrite(filePath: string, workspace: string): string | null {
  if (!filePath) return null;
  const abs = path.resolve(workspace, filePath);
  if (abs === workspace || abs.startsWith(workspace + path.sep)) return null;
  return `You may only write inside the workspace ${workspace}.`;
}

export function guardHook(workspace: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const ti = input.tool_input as Record<string, unknown>;
    let reason: string | null = null;
    if (input.tool_name === 'Bash') reason = checkBash(String(ti.command ?? ''));
    else if (['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name)) reason = checkWrite(String(ti.file_path ?? ti.notebook_path ?? ''), workspace);
    if (!reason) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } };
  };
}
