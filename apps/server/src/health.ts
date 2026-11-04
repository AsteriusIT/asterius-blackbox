import { config } from './config.js';
import { one } from './db.js';
import { gitProvider } from './providers/git.js';
import { kube } from './providers/kubernetes.js';

/**
 * /readyz: dependency checks. Only the database is critical (503): an outage of Azure DevOps, Kubernetes or
 * Anthropic is reported (ok: false) but must not take the UI down. Results are cached briefly so probes and
 * dashboards do not hammer external APIs.
 */

type Check = { ok: boolean; ms: number; error?: string; critical?: boolean };
const CACHE_MS = 15_000;
let cached: { at: number; checks: Record<string, Check> } | undefined;

async function timed(fn: () => Promise<unknown>, critical = false): Promise<Check> {
  const t = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout after 5s')), 5000).unref())]);
    return { ok: true, ms: Date.now() - t, ...(critical ? { critical } : {}) };
  } catch (err) {
    return { ok: false, ms: Date.now() - t, error: (err as Error).message.slice(0, 300), ...(critical ? { critical } : {}) };
  }
}

async function anthropic() {
  const key = config.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/models?limit=1`, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) throw new Error(`Anthropic API answered ${res.status}`);
}

export async function readiness(force = false) {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.checks;
  const entries: [string, Promise<Check>][] = [
    ['database', timed(() => one('SELECT 1 AS ok'), true)],
    ['git', timed(() => gitProvider().ping())],
    ['anthropic', timed(anthropic)],
  ];
  if (config.K8S_ENABLED) entries.push(['kubernetes', timed(() => kube().ping())]);
  const checks = Object.fromEntries(await Promise.all(entries.map(async ([k, p]) => [k, await p] as const)));
  cached = { at: Date.now(), checks };
  return checks;
}

export const isReady = (checks: Record<string, Check>) => Object.values(checks).every((c) => c.ok || !c.critical);
