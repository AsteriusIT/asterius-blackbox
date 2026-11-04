import { describe, expect, it } from 'vitest';
import { applicationEntity, previewEntity, serviceEntity, type AppFacts } from '../src/integrations/port/mapping.js';
import type { AppRow, EnvRow } from '../src/db.js';

const app = {
  id: 'app-1',
  owner_id: 'u',
  name: 'Loans',
  slug: 'loans',
  description: 'Library loans',
  status: 'error',
  phase: null,
  repo_id: 'r1',
  repo_name: 'loans',
  repo_web_url: 'https://dev.azure.com/o/p/_git/loans',
  repo_clone_url: 'x',
  agent_session_id: null,
  last_error: 'boom',
  created_at: '2026-01-02 03:04:05',
  updated_at: '2026-01-02 03:04:05',
} as AppRow;
const facts: AppFacts = {
  app,
  ownerEmail: 'a@x.io',
  lastProgress: null,
  lastActivity: null,
  totalCostUsd: 1.236,
  runs: 2,
  openPrs: 1,
  livePreviewUrl: null,
  isAzureRepo: true,
};

describe('port mapping', () => {
  it('maps an application, dropping empty values', () => {
    const e = applicationEntity(facts, ['team-a']);
    expect(e).toMatchObject({ identifier: 'app-1', title: 'Loans', team: ['team-a'], relations: { service: 'loans', repository: 'r1' } });
    expect(e.properties).toMatchObject({ status: 'error', last_error: 'boom', total_cost_usd: 1.24, runs: 2, created_at: '2026-01-02T03:04:05.000Z' });
    expect(e.properties).not.toHaveProperty('phase');
    expect(e.properties).not.toHaveProperty('live_preview_url');
  });
  it('links the service to the ADO repo only for Azure repos', () => {
    expect(serviceEntity(facts, undefined).relations).toEqual({ azureDevopsRepository: 'r1' });
    expect(serviceEntity({ ...facts, isAzureRepo: false }, undefined).relations).toEqual({});
  });
  it('maps a preview and hides the message once ready', () => {
    const env = {
      id: 'e',
      app_id: 'app-1',
      name: 'loans-main',
      namespace: 'bb-loans-main',
      branch: 'main',
      commit_sha: 'abc',
      image: null,
      url: 'http://u',
      status: 'ready',
      message: 'Ready',
      expires_at: null,
      created_at: '',
      updated_at: '',
    } as EnvRow;
    const e = previewEntity(env, undefined);
    expect(e).toMatchObject({ identifier: 'loans-main', relations: { application: 'app-1' }, properties: { url: 'http://u', status: 'ready', commit: 'abc' } });
    expect(e.properties).not.toHaveProperty('message');
  });
});
