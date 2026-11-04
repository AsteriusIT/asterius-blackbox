# Architecture

## Components

| Path | Role |
|---|---|
| `apps/server/src/routes/api.ts` | REST API + `/api/stream` (SSE, one stream per user). |
| `apps/server/src/entra.ts` | Microsoft Entra ID sign-in (OIDC code flow + PKCE, ID token verification with `jose`). |
| `apps/server/src/db.ts` | Storage driver (SQLite, or Postgres when `DATABASE_URL=postgres://…`) and numbered migrations (`schema_migrations`). The same SQL runs on both (`datetime('now')` / `json_extract` exist as Postgres functions). |
| `apps/server/src/events.ts` | Event bus: every user-visible event is persisted (replay after reload) and fanned out. Notifications are also forwarded to `NOTIFY_WEBHOOK_URL`. |
| `apps/server/src/agent/runner.ts` | One Claude Agent SDK session per application: workspace clone, SDK options, run bookkeeping. |
| `apps/server/src/agent/mapper.ts` | SDK message → activity/message/summary mapping (pure, unit-tested). |
| `apps/server/src/agent/guard.ts` | `PreToolUse` guard (best-effort command inspection). |
| `apps/server/src/agent/tools.ts` | In-process MCP server `blackbox`: `report_progress`, `share_plan`, `notify_user`, `create_pull_request`, `get_pull_request`, `comment_on_pull_request`, `enable_ci`, `deploy_environment`, `environment_status`, `environment_logs`, `delete_environment`. |
| `apps/server/src/agent/prompt.ts` | Planner system prompt (appended to the Claude Code preset), coder subagent definition, tool allow-lists. |
| `apps/server/src/providers/azure-devops.ts` | Repos, initial commit, branch policies, PRs, threads, policy evaluations, pipelines. |
| `apps/server/src/providers/kubernetes.ts` | Image builds (in-cluster Kaniko, or local Docker + kind/k3d/minikube load), namespaces + guard rails, addons, rollout wait, logs, TTL reaper. |
| `apps/server/src/integrations/port/` | Port: REST client, entity mapping, debounced catalog sync, planner tools, signed action receiver. |
| `apps/server/src/providers/github.ts` | GitHub: repositories, `main` ruleset, PRs/reviews/check runs, Actions as required check. |
| `apps/server/src/access.ts` | Shared applications: owner / editor / viewer, users or Entra groups; who receives an app's live events. |
| `apps/server/src/environments.ts` | Preview deploys (agent tool, promotion, staging redeploy after merge), TTL extension and pinning. |
| `apps/server/src/app-config.ts` | Per-app configuration and secrets (AES-256-GCM), injected into previews; the agent only sees names. |
| `apps/server/src/costs.ts` | Cost reports and monthly budgets per user / app / platform (block new runs). |
| `apps/server/src/audit.ts` | Append-only audit log of platform actions (JSON / CSV export). |
| `apps/server/src/lifecycle.ts` | Archive (read-only) and delete (repository, previews, Port entities, data) of applications. |
| `apps/server/src/integrations/pr-feedback.ts` | Review loop: polls open PRs; new reviewer comments or failing checks queue a run. |
| `apps/server/src/templates.ts` + `apps/server/templates/` | Starters (Node API, React SPA, Python FastAPI, .NET API) committed as the first commit. |
| `apps/server/src/agent/attachments.ts` | Chat attachments → image / PDF / text content blocks for the agent. |
| `apps/server/src/maintenance.ts` | Daily: activity-event retention, workspace GC. |
| `apps/server/src/health.ts`, `metrics.ts`, `tracing.ts` | `/readyz`, `/metrics` (Prometheus), OpenTelemetry. |
| `packages/shared` | Types shared by server and web (rows, events, API responses; declarations only). |
| `deploy/helm/blackbox` | Helm chart: single pod, or API + worker pods on Postgres; RBAC and admission policy. |
| `scripts/backup.sh` | Backup / restore of the database, agent sessions, local repositories and attachments. |
| `scripts/local-cluster.sh` | Local kind cluster with ingress-nginx for previews on a dev machine. |
| `apps/web` | React UI: dashboard (grid of applications), chat, activity timeline, environments, PRs, toasts and browser notifications. |

## The agent loop

```
user message ─▶ sendUserMessage (any API pod)
                 ├─ a run is executing → message tagged with that run + `feedback` signal → the worker pushes it
                 │                        into the live prompt stream (agent sees it at its next step)
                 └─ otherwise          → message joins the app's queued run (one per app); `wake` signal

scheduler (BLACKBOX_ROLE=all|worker): claims the oldest queued run allowed by AGENT_MAX_CONCURRENT_RUNS
  (cluster-wide), AGENT_MAX_RUNS_PER_USER and one-run-per-app, under an advisory lock; heartbeats every 15 s.
  Messages that arrive too late for a run are re-queued for the next one; stale runs (dead worker) are
  stopped, or resumed in the same agent session with AGENT_RESUME_INTERRUPTED=true.

executeRun: clone/fetch workspace → query({ prompt: stream, resume, model: PLANNER, agents: { coder }, mcpServers: {blackbox}, hooks, sandbox })
   planner: understand → share_plan → [Agent(coder) per step → verify]* → PR → deploy preview → final message
   for each SDK message:
     assistant text      → buffered; becomes "narration" if a tool call follows, the final chat reply otherwise
     tool_use            → `activity` event (git / edit / test / shell / deploy …) tagged actor=planner|coder; planner TodoWrite → live checklist
     tool_result error   → `activity` error
     result              → run finished, cost/turns saved, user notified, stream closed unless feedback is pending
```

The agent "loops until done" because it is a full Claude Code harness: it keeps calling tools (edit, run tests, push, deploy, read logs, fix) until it decides the request is complete. `AGENT_MAX_TURNS` and `AGENT_MAX_BUDGET_USD` bound a single run. Sessions are persisted under `DATA_DIR/agent-home`, so feedback hours later resumes with full context.

## Security boundaries

1. **`main` protection is enforced by Azure DevOps**, not by the agent's good behaviour. The agent's git identity (`ADO_AGENT_GIT_PAT`) has no bypass permission. A `PreToolUse` hook (`agent/guard.ts`) additionally denies pushes to main, force/mirror/delete pushes, git aliases, non-literal refspecs, `kubectl`/`az`/`helm` and touching git credentials, so mistakes fail fast with an explanation. **It is best-effort**: string inspection cannot stop a script file, `eval` of computed strings or an interpreter. Never rely on it as a security control.
2. **Platform credentials stay in the server process.** The agent subprocess gets a minimal environment (no `ADO_ADMIN_PAT`, no kubeconfig). Cluster and ADO admin actions go only through the `mcp__blackbox__*` tools, which only target the app's own repo and `bb-*` namespaces.
3. **Shell sandbox** (`AGENT_SANDBOX=true`): bash runs under bubblewrap with writes limited to the workspace and `/tmp`. Reads of all of `DATA_DIR` are denied (DB, `kubeconfig-local`, other apps' workspaces and their git credentials) except the app's own workspace and the agent home, as are `~/.kube` and `KUBECONFIG_PATH`. This is the real control behind the guard hook.
4. **Cluster isolation:** one namespace per environment with quota, limit range and a NetworkPolicy; pods have no service-account token; environments expire. `K8S_PREVIEW_EGRESS=none|dns-only|allowlist` adds an egress NetworkPolicy (same namespace, + cluster DNS, + `K8S_PREVIEW_EGRESS_ALLOWLIST` CIDRs).
5. **Admission policy:** The Helm chart's ValidatingAdmissionPolicy (`kubernetes.admissionPolicy`) only lets the `blackbox` service account write in namespaces labelled `app.kubernetes.io/managed-by=asterius-blackbox` (and `blackbox-builds`), whatever its ClusterRole allows.

### Hardening for production
- Run agent sessions in **separate worker pods**: `BLACKBOX_ROLE=api` for the web/API Deployment (any number of replicas) and `BLACKBOX_ROLE=worker` for the agent Deployment, both on Postgres (`DATABASE_URL`). A compromised session then cannot reach the API process. Workers need the same `DATA_DIR` (ReadWriteMany volume) for `agent-home` (agent sessions, needed to resume) and the workspaces (re-cloned when missing).

## Operations

- `GET /healthz`: liveness. `GET /readyz`: database (critical, 503), git provider, Kubernetes API and Anthropic checks, cached 15 s.
- `GET /metrics` (Prometheus, optional `METRICS_TOKEN`): `blackbox_runs_started_total`, `blackbox_runs_finished_total{status}`, `blackbox_run_duration_seconds`, `blackbox_run_cost_usd_total`, `blackbox_tokens_total{kind}`, `blackbox_builds_total{result}`, `blackbox_sse_clients`; cluster-wide gauges from the DB: `blackbox_runs{status=queued|running}` (queue depth), `blackbox_environments{status}`.
- Tracing (OpenTelemetry, enabled by `OTEL_EXPORTER_OTLP_ENDPOINT`): one `agent.run` span per run, a `tool <name>` child span per platform tool call, `k8s.build` / `k8s.rollout` inside deployments, and every outgoing `fetch` (Azure DevOps, Port, Entra) as a child of the active span.

## Event types (SSE / `GET /api/apps/:id/events`)

`app.updated` · `message.created` · `run.started` · `run.finished` · `progress` (phase, title, detail, step/totalSteps) · `activity` (kind, title, detail, todos) · `env.updated` · `pr.updated` · `notification` (level, title, message, link)
