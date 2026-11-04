import { describe, expect, it } from 'vitest';

process.env.ADMIN_EMAILS = 'admin@x.io';
process.env.BUDGET_USER_MONTHLY_USD = '10';

const Fastify = (await import('fastify')).default;
const { apiRoutes } = await import('../src/routes/api.js');
const { createSession, createUser } = await import('../src/auth.js');
const { budgetBlock, currentMonth } = await import('../src/costs.js');
const { newId, run } = await import('../src/db.js');

const server = Fastify();
await server.register(apiRoutes);
const as = (t: string) => ({ authorization: `Bearer ${t}` });

async function app(ownerId: string, name: string) {
  const id = newId();
  await run("INSERT INTO applications (id, owner_id, name, slug, description, status, repo_id) VALUES (?, ?, ?, ?, '', 'idle', 'r')", id, ownerId, name, id);
  return id;
}
const spend = (appId: string, usd: number, startedAt = new Date().toISOString()) =>
  run("INSERT INTO runs (id, app_id, status, cost_usd, started_at) VALUES (?, ?, 'succeeded', ?, ?)", newId(), appId, usd, startedAt);

describe('costs and budgets', () => {
  it('reports spend and blocks new runs once a monthly budget is used up', async () => {
    const ana = await createUser('ana@x.io', 'Ana', 'password1');
    const admin = await createUser('admin@x.io', 'Admin', 'password1');
    const [ta, tadm] = [await createSession(ana.id), await createSession(admin.id)];
    const a1 = await app(ana.id, 'One');
    const a2 = await app(ana.id, 'Two');
    await spend(a1, 4);
    await spend(a2, 3.5);
    await spend(a1, 100, '2001-01-15 10:00:00'); // another month (SQLite timestamp format)

    const report = (await server.inject({ url: '/api/costs', headers: as(ta) })).json();
    expect(report.month).toBe(currentMonth());
    expect(report.me).toEqual({ spentUsd: 7.5, budgetUsd: 10 });
    expect(report.apps.map((x: { name: string; monthUsd: number; totalUsd: number }) => [x.name, x.monthUsd, x.totalUsd])).toEqual([
      ['One', 4, 104],
      ['Two', 3.5, 3.5],
    ]);
    expect(report.users).toBeUndefined(); // not an admin
    expect(await budgetBlock(a1)).toBeNull();

    // per-app override reached → blocked, with a clear message in the chat
    expect((await server.inject({ method: 'PUT', url: '/api/budgets', headers: as(ta), payload: { scope: `app:${a1}`, monthlyUsd: 4 } })).statusCode).toBe(403);
    expect((await server.inject({ method: 'PUT', url: '/api/budgets', headers: as(tadm), payload: { scope: `app:${a1}`, monthlyUsd: 4 } })).statusCode).toBe(
      200,
    );
    expect(await budgetBlock(a1)).toMatch(/budget of this application is used up \(\$4\.00 of \$4\.00\)/);
    const res = await server.inject({ method: 'POST', url: `/api/apps/${a1}/messages`, headers: as(ta), payload: { content: 'more' } });
    expect(res.statusCode).toBe(402);

    // the user's default budget (10) is reached across apps
    await spend(a2, 3);
    expect(await budgetBlock(a2)).toMatch(/owner's monthly budget|budget of the application owner's is used up/);

    // admins see per-user totals and can lift a budget
    const adminReport = (await server.inject({ url: '/api/costs', headers: as(tadm) })).json();
    expect(adminReport.users.find((u: { email: string }) => u.email === 'ana@x.io')).toMatchObject({ monthUsd: 10.5, budgetUsd: 10 });
    await server.inject({ method: 'PUT', url: '/api/budgets', headers: as(tadm), payload: { scope: `user:${ana.id}`, monthlyUsd: 0 } });
    expect(await budgetBlock(a2)).toBeNull();
  });
});
