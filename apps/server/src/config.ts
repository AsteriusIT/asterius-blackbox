import { z } from 'zod';
import path from 'node:path';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  DATA_DIR: z.string().default(path.resolve(process.cwd(), '../../data')),
  PUBLIC_URL: z.string().default('http://localhost:5173'),
  /** Empty: SQLite under DATA_DIR (single instance). postgres://… for several replicas / worker pods. */
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_SIZE: z.coerce.number().default(10),
  /** 32-byte key (base64 or hex) encrypting application secrets; generated under DATA_DIR when unset (single instance only). */
  SECRETS_KEY: z.string().optional(),
  /** Optional bearer token required on /metrics. */
  METRICS_TOKEN: z.string().optional(),
  /** Serve the built web UI from the API process (production image). */
  WEB_DIST_DIR: z.string().optional(),
  /** Comma-separated sign-in methods: `local` (email + password) and/or `entra` (Microsoft Entra ID SSO). */
  AUTH_PROVIDERS: z
    .string()
    .default('local')
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(['local', 'entra'])).min(1)),
  /** Poll open pull requests every N seconds and let the agent address new review comments / failing checks (0 = off). */
  PR_FEEDBACK_POLL_SECONDS: z.coerce.number().int().min(0).default(120),
  /** Comma-separated emails of platform admins (global audit log, costs and budgets). */
  ADMIN_EMAILS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Local accounts only: allow self-registration. */
  ALLOW_REGISTRATION: bool(true),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  /** Defaults to `${PUBLIC_URL}/api/auth/entra/callback` (must be registered on the app). */
  ENTRA_REDIRECT_URI: z.string().optional(),

  // ---- Agent ----
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Step 1 — the planner/lead: understands the request, plans, delegates, reviews, ships (PRs, environments). */
  AGENT_PLANNER_MODEL: z.string().default('claude-opus-5-5'),
  AGENT_PLANNER_EFFORT: effort.default('high'),
  /** Step 2 — the coder subagent: implements each step of the plan (code, tests, commits, pushes). */
  AGENT_CODER_MODEL: z.string().default('claude-sonnet-5-5'),
  AGENT_CODER_EFFORT: effort.default('medium'),
  /** When true the planner shares its plan and waits for the user's go before building. */
  AGENT_REQUIRE_PLAN_APPROVAL: bool(false),
  AGENT_MAX_TURNS: z.coerce.number().default(400),
  /** Monthly budgets (USD, UTC calendar month) that block new runs once reached; 0 = unlimited. Admins can override per user/app. */
  BUDGET_USER_MONTHLY_USD: z.coerce.number().min(0).default(0),
  BUDGET_APP_MONTHLY_USD: z.coerce.number().min(0).default(0),
  BUDGET_GLOBAL_MONTHLY_USD: z.coerce.number().min(0).default(0),
  /** Hard cap in USD for a single run (one user message → agent done). */
  AGENT_MAX_BUDGET_USD: z.coerce.number().default(25),
  /** Cluster-wide cap on concurrently running agent sessions (each may also run an image build). */
  AGENT_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).default(4),
  /** Per-user cap on concurrently running agent sessions; further requests wait in the queue. */
  AGENT_MAX_RUNS_PER_USER: z.coerce.number().int().min(1).default(2),
  /** After a restart, resume runs that were interrupted (same agent session) instead of stopping them. */
  AGENT_RESUME_INTERRUPTED: bool(false),
  /** all: API + agent worker in one process (default) | api: HTTP only | worker: runs agent sessions only. */
  BLACKBOX_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  /** Max agent sessions this worker process runs at once (defaults to AGENT_MAX_CONCURRENT_RUNS). */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).optional(),
  /** Stable worker identity (defaults to the hostname = pod name) used to recover its runs after a restart. */
  WORKER_ID: z.string().optional(),
  /** Delete low-level activity events of finished runs after N days (0 = keep forever). Messages and milestones stay. */
  EVENTS_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  /** Remove workspace clones of applications idle for N days (0 = never); they are re-cloned on demand. */
  WORKSPACE_GC_DAYS: z.coerce.number().int().min(0).default(14),
  /** Run the agent's shell commands in the Claude Code sandbox (bubblewrap on Linux). */
  AGENT_SANDBOX: bool(true),

  // ---- Git provider ----
  /** `azure-devops` for real use, `local` for offline dev (bare repos + a hook that rejects pushes to main). */
  GIT_PROVIDER: z.enum(['azure-devops', 'github', 'local']).default('local'),
  /** GitHub: organization or user that owns the repositories. */
  GITHUB_OWNER: z.string().optional(),
  /** Platform token: repositories (create/delete), rulesets, pull requests. Never given to the agent. */
  GITHUB_ADMIN_TOKEN: z.string().optional(),
  /** Agent token for git push: contents read/write only, not a ruleset bypass actor. */
  GITHUB_AGENT_TOKEN: z.string().optional(),
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  GITHUB_MIN_REVIEWERS: z.coerce.number().int().min(0).default(1),
  ADO_ORG_URL: z.string().optional(), // https://dev.azure.com/my-org
  ADO_PROJECT: z.string().optional(),
  /** PAT used by the platform: repo creation, branch policies, PRs. Never exposed to the agent. */
  ADO_ADMIN_PAT: z.string().optional(),
  /** PAT the agent's git uses (Code: Read & Write only). The identity must NOT have "Bypass policies when pushing". */
  ADO_AGENT_GIT_PAT: z.string().optional(),
  /** Optional: id of a reviewer group/user that must approve PRs (defaults to the min-reviewer policy only). */
  ADO_REQUIRED_REVIEWER_ID: z.string().optional(),
  ADO_MIN_REVIEWERS: z.coerce.number().default(1),
  /** Create a build-validation policy using the repo's azure-pipelines.yml once the agent adds one. */
  ADO_BUILD_VALIDATION: bool(true),

  // ---- Kubernetes environments ----
  K8S_ENABLED: bool(false),
  /** Leave empty to use in-cluster config or ~/.kube/config. */
  KUBECONFIG_PATH: z.string().optional(),
  K8S_CONTEXT: z.string().optional(),
  K8S_NAMESPACE_PREFIX: z.string().default('bb'),
  /**
   * How images are built:
   *  - kaniko: in-cluster Kaniko job cloning the branch from Azure DevOps (production)
   *  - docker: local `docker build` from the agent workspace (local clusters, works with GIT_PROVIDER=local)
   */
  K8S_BUILD_MODE: z.enum(['kaniko', 'docker']).default('kaniko'),
  /** docker mode only — how the built image reaches the cluster. */
  K8S_IMAGE_LOAD: z.enum(['push', 'kind', 'k3d', 'minikube', 'none']).default('push'),
  /** kind / k3d cluster name used by K8S_IMAGE_LOAD. */
  K8S_LOCAL_CLUSTER_NAME: z.string().default('blackbox'),
  /** kaniko only — push to a plain-HTTP registry (e.g. an in-cluster registry). */
  K8S_REGISTRY_INSECURE: bool(false),
  K8S_BUILD_NAMESPACE: z.string().default('blackbox-builds'),
  /** e.g. myregistry.azurecr.io/blackbox */
  K8S_IMAGE_REGISTRY: z.string().default('registry.local/blackbox'),
  /** Secret (type dockerconfigjson) in K8S_BUILD_NAMESPACE used by Kaniko to push. */
  K8S_REGISTRY_PUSH_SECRET: z.string().default('registry-push'),
  /** Optional pull secret name copied into env namespaces (not needed when AKS is attached to ACR). */
  K8S_REGISTRY_PULL_SECRET: z.string().optional(),
  K8S_KANIKO_IMAGE: z.string().default('gcr.io/kaniko-project/executor:v1.23.2'),
  K8S_INGRESS_CLASS: z.string().default('nginx'),
  /** Namespace of the ingress controller (allowed through the per-environment NetworkPolicy). */
  K8S_INGRESS_NAMESPACE: z.string().default('ingress-nginx'),
  /** Environments are exposed on https://<env>.<K8S_BASE_DOMAIN> */
  K8S_BASE_DOMAIN: z.string().default('localtest.me'),
  /** Host port of the ingress when it is not 80/443 (local clusters), appended to preview URLs. */
  K8S_PUBLIC_PORT: z.string().optional(),
  K8S_INGRESS_TLS_SECRET: z.string().optional(),
  K8S_CLUSTER_ISSUER: z.string().optional(),
  K8S_ENV_TTL_HOURS: z.coerce.number().default(72),
  /** Upper bound when people extend a preview's lifetime (pinning has no limit). */
  K8S_ENV_MAX_TTL_DAYS: z.coerce.number().default(30),
  /**
   * Outbound traffic of preview pods: all (default) | none (same namespace only) | dns-only (+ cluster DNS)
   * | allowlist (+ DNS + K8S_PREVIEW_EGRESS_ALLOWLIST CIDRs).
   */
  K8S_PREVIEW_EGRESS: z.enum(['all', 'none', 'dns-only', 'allowlist']).default('all'),
  /** Comma-separated CIDRs, e.g. 10.0.0.0/8,52.10.20.30/32 */
  K8S_PREVIEW_EGRESS_ALLOWLIST: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),

  // ---- Port (getport.io) ----
  /** Port API credentials (Port → ... → Credentials). When set, Blackbox syncs its catalog to Port. */
  PORT_CLIENT_ID: z.string().optional(),
  PORT_CLIENT_SECRET: z.string().optional(),
  /** EU: https://api.port.io — US: https://api.us.port.io */
  PORT_API_URL: z.string().default('https://api.port.io'),
  /** Also create/update a `service` entity per application (scorecards, ownership, DORA). */
  PORT_SYNC_SERVICES: bool(true),
  /** Port team used as owner when the requester has no Port team. */
  PORT_DEFAULT_TEAM: z.string().optional(),
  /** Give the planner read-only Port tools (existing services, production-readiness scorecards). */
  PORT_AGENT_CONTEXT: bool(true),
  /** Accept self-service action webhooks from Port (needs Blackbox reachable by Port, or the Port execution agent). */
  PORT_ACTIONS_ENABLED: bool(false),

  // ---- Notifications ----
  /** Optional incoming webhook (Teams / Slack compatible JSON `{text}`) for "environment ready" etc. */
  NOTIFY_WEBHOOK_URL: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

if (config.AUTH_PROVIDERS.includes('entra') && !(config.ENTRA_TENANT_ID && config.ENTRA_CLIENT_ID && config.ENTRA_CLIENT_SECRET)) {
  throw new Error('AUTH_PROVIDERS includes "entra": set ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET (scripts/entra-app.sh does it).');
}

export const paths = {
  db: path.join(config.DATA_DIR, 'blackbox.db'),
  workspaces: path.join(config.DATA_DIR, 'workspaces'),
  localRepos: path.join(config.DATA_DIR, 'git'),
};
