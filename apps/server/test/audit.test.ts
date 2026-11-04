import { describe, expect, it } from 'vitest';
import { audit, toCsv, type AuditRow } from '../src/audit.js';
import { all } from '../src/db.js';

describe('audit log', () => {
  it('records entries and exports CSV with escaping', async () => {
    await audit({
      action: 'env.deleted',
      via: 'api',
      actorId: 'u1',
      actorEmail: 'a@x.io',
      appId: 'app-1',
      target: 'shop-main',
      detail: { note: 'said "bye", ok' },
    });
    const rows = await all<AuditRow>("SELECT * FROM audit_log WHERE app_id = 'app-1'");
    expect(rows).toHaveLength(1);
    const csv = toCsv(rows).split('\n');
    expect(csv[0]).toBe('at,action,via,actor_email,actor_id,app_id,target,detail');
    expect(csv[1]).toMatch(/,env\.deleted,api,a@x\.io,u1,app-1,shop-main,"\{""note"":""said \\""bye\\"", ok""\}"$/);
  });
});
