import { config } from '../../config.js';
import type { AppRow, EnvRow } from '../../db.js';
import type { PortEntity } from './client.js';

/**
 * Pure mapping Blackbox → Port entities (no I/O), so it can be unit-tested and dry-run.
 * Blueprints: blackboxApplication, previewEnvironment, and the existing `service` (from the ADO setup).
 */

export const BP = { app: 'blackboxApplication', preview: 'previewEnvironment', service: 'service' } as const;

export interface AppFacts {
  app: AppRow;
  ownerEmail: string | null;
  lastProgress: string | null;
  lastActivity: string | null;
  totalCostUsd: number;
  runs: number;
  openPrs: number;
  livePreviewUrl: string | null;
  isAzureRepo: boolean;
}

const iso = (sqliteOrIso: string | null | undefined) => {
  if (!sqliteOrIso) return undefined;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(sqliteOrIso) ? sqliteOrIso : sqliteOrIso.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** Drop undefined/null so Port never sees invalid values for typed properties. */
function clean<T extends Record<string, unknown>>(o: T) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<T>;
}

/** Service identifiers follow the app slug (stable, human-readable, unique in Blackbox). */
export const serviceId = (app: AppRow) => app.slug;

export function serviceEntity(f: AppFacts, team: string[] | undefined): PortEntity {
  return {
    identifier: serviceId(f.app),
    title: f.app.name,
    ...(team ? { team } : {}),
    properties: {},
    relations: f.isAzureRepo && f.app.repo_id ? { azureDevopsRepository: f.app.repo_id } : {},
  };
}

export function applicationEntity(f: AppFacts, team: string[] | undefined): PortEntity {
  const { app } = f;
  return {
    identifier: app.id,
    title: app.name,
    ...(team ? { team } : {}),
    properties: clean({
      description: app.description,
      status: app.status,
      phase: app.phase ?? undefined,
      last_progress: f.lastProgress ?? undefined,
      last_error: app.status === 'error' ? app.last_error ?? undefined : undefined,
      chat_url: `${config.PUBLIC_URL.replace(/\/$/, '')}/apps/${app.id}`,
      repository_url: app.repo_web_url?.startsWith('http') ? app.repo_web_url : undefined,
      live_preview_url: f.livePreviewUrl ?? undefined,
      requested_by: f.ownerEmail ?? undefined,
      planner_model: config.AGENT_PLANNER_MODEL,
      coder_model: config.AGENT_CODER_MODEL,
      total_cost_usd: Math.round(f.totalCostUsd * 100) / 100,
      runs: f.runs,
      open_prs: f.openPrs,
      last_activity: iso(f.lastActivity ?? app.updated_at),
      created_at: iso(app.created_at),
    }),
    relations: {
      service: config.PORT_SYNC_SERVICES ? serviceId(app) : null,
      repository: f.isAzureRepo && app.repo_id ? app.repo_id : null,
    },
  };
}

export function previewEntity(env: EnvRow, team: string[] | undefined): PortEntity {
  return {
    identifier: env.name,
    title: env.name,
    ...(team ? { team } : {}),
    properties: clean({
      url: env.url ?? undefined,
      status: env.status,
      branch: env.branch,
      commit: env.commit_sha ?? undefined,
      namespace: env.namespace,
      message: env.status === 'ready' ? undefined : env.message?.slice(0, 2000) ?? undefined,
      expires_at: iso(env.expires_at),
      updated_at: iso(env.updated_at),
    }),
    relations: { application: env.app_id },
  };
}
