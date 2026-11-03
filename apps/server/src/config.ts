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
  /** Serve the built web UI from the API process (production image). */
  WEB_DIST_DIR: z.string().optional(),
  /** Comma-separated sign-in methods: `local` (email + password) and/or `entra` (Microsoft Entra ID SSO). */
  AUTH_PROVIDERS: z
    .string()
    .default('local')
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(['local', 'entra'])).min(1)),
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
  /** Hard cap in USD for a single run (one user message → agent done). */
  AGENT_MAX_BUDGET_USD: z.coerce.number().default(25),
  /** Run the agent's shell commands in the Claude Code sandbox (bubblewrap on Linux). */
  AGENT_SANDBOX: bool(true),

  // ---- Git provider ----
  /** `azure-devops` for real use, `local` for offline dev (bare repos + a hook that rejects pushes to main). */
  GIT_PROVIDER: z.enum(['azure-devops', 'local']).default('local'),
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
