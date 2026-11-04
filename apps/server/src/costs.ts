import { config } from './config.js';
import { all, one, run } from './db.js';
import type { CostReport } from '@blackbox/shared';

/**
 * Cost control. Every run's Anthropic cost is stored (runs.cost_usd) and attributed to its application and to the
 * application's owner. Monthly budgets (UTC calendar month) per user, per application and for the whole platform
 * block NEW runs once reached; 0 = unlimited. Defaults come from BUDGET_*_MONTHLY_USD, admins override them per
 * user/app in the `budgets` table.
 */

export const currentMonth = (d = new Date()) => d.toISOString().slice(0, 7); // YYYY-MM
// started_at is "YYYY-MM-DD HH:MM:SS" (older rows) or ISO: the first 7 characters are the month either way.
const IN_MONTH = 'substr(r.started_at, 1, 7) = ?';

export type Scope = `user:${string}` | `app:${string}` | 'global';

export async function budgetFor(scope: Scope): Promise<number> {
  const o = await one<{ monthly_usd: number }>('SELECT monthly_usd FROM budgets WHERE scope = ?', scope);
  if (o) return Number(o.monthly_usd);
  return scope === 'global' ? config.BUDGET_GLOBAL_MONTHLY_USD : scope.startsWith('user:') ? config.BUDGET_USER_MONTHLY_USD : config.BUDGET_APP_MONTHLY_USD;
}

/** null removes the override (back to the default). */
export async function setBudget(scope: Scope, monthlyUsd: number | null) {
  if (monthlyUsd === null) await run('DELETE FROM budgets WHERE scope = ?', scope);
  else
    await run('INSERT INTO budgets (scope, monthly_usd) VALUES (?, ?) ON CONFLICT (scope) DO UPDATE SET monthly_usd = excluded.monthly_usd', scope, monthlyUsd);
}

const sum = async (where: string, ...params: (string | number)[]) =>
  Number(
    (
      await one<{ c: number | null }>(
        `SELECT sum(r.cost_usd) AS c FROM runs r JOIN applications a ON a.id = r.app_id WHERE ${IN_MONTH} AND ${where}`,
        currentMonth(),
        ...params,
      )
    )?.c ?? 0,
  );

export const spentByUser = (userId: string) => sum('a.owner_id = ?', userId);
export const spentByApp = (appId: string) => sum('r.app_id = ?', appId);
export const spentGlobal = () => sum('1 = 1');

/** Why a new run of this app must not start (a budget is used up), or null. */
export async function budgetBlock(appId: string): Promise<string | null> {
  const app = await one<{ owner_id: string }>('SELECT owner_id FROM applications WHERE id = ?', appId);
  if (!app) return null;
  const checks: [string, Scope, () => Promise<number>][] = [
    ['this application', `app:${appId}`, () => spentByApp(appId)],
    ["the application owner's", `user:${app.owner_id}`, () => spentByUser(app.owner_id)],
    ['the platform', 'global', spentGlobal],
  ];
  for (const [label, scope, spent] of checks) {
    const budget = await budgetFor(scope);
    if (!budget) continue;
    const s = await spent();
    if (s >= budget)
      return `The monthly budget of ${label} is used up ($${s.toFixed(2)} of $${budget.toFixed(2)}). It resets on the 1st; an administrator can raise it.`;
  }
  return null;
}

/** Cost overview: the user's own spend and their visible applications; platform-wide figures for admins. */
export async function costReport(user: { id: string }, visible: { sql: string; params: string[] }, admin: boolean): Promise<CostReport> {
  const month = currentMonth();
  const apps = await all<{ id: string; name: string; owner_id: string; month_usd: number | null; total_usd: number | null; runs: number }>(
    `SELECT a.id, a.name, a.owner_id,
       (SELECT sum(r.cost_usd) FROM runs r WHERE r.app_id = a.id AND ${IN_MONTH}) AS month_usd,
       (SELECT sum(r.cost_usd) FROM runs r WHERE r.app_id = a.id) AS total_usd,
       (SELECT count(*) FROM runs r WHERE r.app_id = a.id AND ${IN_MONTH}) AS runs
     FROM applications a WHERE ${visible.sql}`,
    month,
    month,
    ...visible.params,
  );
  const report = {
    month,
    me: { spentUsd: await spentByUser(user.id), budgetUsd: await budgetFor(`user:${user.id}`) },
    apps: (
      await Promise.all(
        apps.map(async (a) => ({
          id: a.id,
          name: a.name,
          ownerId: a.owner_id,
          monthUsd: Number(a.month_usd ?? 0),
          totalUsd: Number(a.total_usd ?? 0),
          runs: Number(a.runs),
          budgetUsd: await budgetFor(`app:${a.id}`),
        })),
      )
    ).sort((x, y) => y.monthUsd - x.monthUsd),
  };
  if (!admin) return report;
  const users = await all<{ id: string; email: string; month_usd: number | null }>(
    `SELECT u.id, u.email, (SELECT sum(r.cost_usd) FROM runs r JOIN applications a ON a.id = r.app_id WHERE a.owner_id = u.id AND ${IN_MONTH}) AS month_usd FROM users u`,
    month,
  );
  return {
    ...report,
    global: { spentUsd: await spentGlobal(), budgetUsd: await budgetFor('global') },
    users: (
      await Promise.all(users.map(async (u) => ({ id: u.id, email: u.email, monthUsd: Number(u.month_usd ?? 0), budgetUsd: await budgetFor(`user:${u.id}`) })))
    ).sort((x, y) => y.monthUsd - x.monthUsd),
  };
}
