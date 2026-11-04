/**
 * Types shared by the server (apps/server) and the web UI (apps/web): database rows exposed by the API, live events
 * and API responses. Declarations only — both sides use `import type`, so nothing is shipped at runtime.
 * Changing a shape here breaks the typecheck on whichever side is not updated.
 */

// ---------------------------------------------------------------- rows
export type AppStatus = 'provisioning' | 'ready' | 'queued' | 'running' | 'idle' | 'error' | 'archived';

export interface AppRow {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string;
  status: AppStatus;
  phase: string | null;
  repo_id: string | null;
  repo_name: string | null;
  repo_web_url: string | null;
  repo_clone_url: string | null;
  agent_session_id: string | null;
  last_error: string | null;
  /** Imported repository (name / URL / path given by the user); NULL when Blackbox created it. Never deleted with the app. */
  repo_source?: string | null;
  /** Starter the repository was created from (templates/<id>). */
  template?: string | null;
  /** 1/0 per application, NULL = AGENT_REQUIRE_PLAN_APPROVAL. */
  require_plan_approval?: number | null;
  created_at: string;
  updated_at: string;
}

/** GET /api/apps, /api/apps/:id */
export type Application = AppRow & {
  running: boolean;
  live_env_url?: string | null;
  env_count?: number;
  open_prs?: number;
  last_progress?: string | null;
  last_activity_at?: string | null;
};

export interface MessageRow {
  id: string;
  app_id: string;
  run_id: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  /** JSON: {"type":"plan","needsApproval":true} | {"attachments":[…]} */
  meta?: string | null;
}

export interface EnvRow {
  id: string;
  app_id: string;
  name: string;
  namespace: string;
  branch: string;
  commit_sha: string | null;
  image: string | null;
  url: string | null;
  status: 'building' | 'deploying' | 'ready' | 'failed' | 'deleted';
  message: string | null;
  expires_at: string | null;
  /** 1 = never expires (long-lived, e.g. staging). */
  pinned?: number;
  /** JSON deploy spec of the last agent deploy (promotion / redeploy). */
  spec?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PullRequestRow {
  id: number;
  app_id: string;
  title: string;
  source_branch: string;
  status: string;
  web_url: string | null;
}

// ---------------------------------------------------------------- live events (SSE, GET /api/apps/:id/events)
export type BlackboxEventType =
  'app.updated' | 'message.created' | 'run.started' | 'run.finished' | 'progress' | 'activity' | 'env.updated' | 'pr.updated' | 'notification';

export interface BlackboxEvent<P = Record<string, unknown>> {
  seq: number;
  appId: string;
  runId: string | null;
  type: BlackboxEventType;
  payload: P;
  createdAt: string;
}

// ---------------------------------------------------------------- API responses
export type Role = 'owner' | 'editor' | 'viewer';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  provider?: 'local' | 'entra';
  admin?: boolean;
}

export interface Platform {
  gitProvider: 'azure-devops' | 'github' | 'local';
  adoProject: string | null;
  policies: string[];
  k8sEnabled: boolean;
  baseDomain: string;
  plannerModel: string;
  coderModel: string;
  buildMode: string;
  authProviders: ('local' | 'entra')[];
  allowRegistration: boolean;
  requirePlanApproval?: boolean;
  /** Port catalog sync status. */
  port: { enabled: boolean; lastSyncAt: string | null; lastError: string | null; synced: number; actions: boolean };
}

export interface Members {
  owner: { id: string; email: string; name: string } | null;
  members: { subject: string; role: 'editor' | 'viewer'; email: string | null; name: string | null }[];
}

export interface Template {
  id: string;
  name: string;
  description: string;
  stack: string;
  port: number;
  healthPath: string;
}

export interface ConfigEntry {
  env: string;
  key: string;
  secret: boolean;
  value: string | null;
  updatedAt: string;
}

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
}
export interface BranchDiff {
  branch: string;
  truncated: boolean;
  files: FileDiff[];
}

export interface RunHistory {
  id: string;
  status: string;
  cost_usd: number | null;
  num_turns: number | null;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  durationSeconds: number | null;
  pullRequests: { id: number; title: string; url?: string }[];
  environments: { name: string; url: string | null }[];
}

export interface CostReport {
  month: string;
  me: { spentUsd: number; budgetUsd: number };
  apps: { id: string; name: string; ownerId: string; monthUsd: number; totalUsd: number; runs: number; budgetUsd: number }[];
  global?: { spentUsd: number; budgetUsd: number };
  users?: { id: string; email: string; monthUsd: number; budgetUsd: number }[];
}

export interface StoredAttachment {
  name: string;
  mediaType: string;
  size: number;
  /** stored file name in the application's attachment folder */
  file: string;
}
export interface Upload {
  name: string;
  mediaType: string;
  /** base64 */
  data: string;
}
