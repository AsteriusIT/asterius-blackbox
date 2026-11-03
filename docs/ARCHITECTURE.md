# Architecture

## Components

| Path | Role |
|---|---|
| `apps/server/src/routes/api.ts` | REST API + `/api/stream` (SSE, one stream per user). |
| `apps/server/src/entra.ts` | Microsoft Entra ID sign-in (OIDC code flow + PKCE, ID token verification with `jose`). |
| `apps/server/src/events.ts` | Event bus: every user-visible event is persisted (replay after reload) and fanned out. Notifications are also forwarded to `NOTIFY_WEBHOOK_URL`. |
| `apps/server/src/agent/runner.ts` | One Claude Agent SDK session per application: workspace clone, prompt stream, message→event mapping, guard hooks, run bookkeeping. |
| `apps/server/src/agent/tools.ts` | In-process MCP server `blackbox`: `report_progress`, `share_plan`, `notify_user`, `create_pull_request`, `get_pull_request`, `comment_on_pull_request`, `enable_ci`, `deploy_environment`, `environment_status`, `environment_logs`, `delete_environment`. |
| `apps/server/src/agent/prompt.ts` | Planner system prompt (appended to the Claude Code preset), coder subagent definition, tool allow-lists. |
| `apps/server/src/providers/azure-devops.ts` | Repos, initial commit, branch policies, PRs, threads, policy evaluations, pipelines. |
| `apps/server/src/providers/kubernetes.ts` | Image builds (in-cluster Kaniko, or local Docker + kind/k3d/minikube load), namespaces + guard rails, addons, rollout wait, logs, TTL reaper. |
| `scripts/local-cluster.sh` | Local kind cluster with ingress-nginx for previews on a dev machine. |
| `apps/web` | React UI: dashboard (grid of applications), chat, activity timeline, environments, PRs, toasts and browser notifications. |

## The agent loop

```
user message ─▶ sendUserMessage
                 ├─ app provisioning?  → queued, starts right after the repo exists
                 ├─ run in progress?   → pushed into the live prompt stream (agent sees it at its next step)
                 └─ idle               → startRun(resume = app.agent_session_id)

startRun: clone/fetch workspace → query({ prompt: stream, resume, model: PLANNER, agents: { coder }, mcpServers: {blackbox}, hooks, sandbox })
   planner: understand → share_plan → [Agent(coder) per step → verify]* → PR → deploy preview → final message
   for each SDK message:
     assistant text      → buffered; becomes "narration" if a tool call follows, the final chat reply otherwise
     tool_use            → `activity` event (git / edit / test / shell / deploy …) tagged actor=planner|coder; planner TodoWrite → live checklist
     tool_result error   → `activity` error
     result              → run finished, cost/turns saved, user notified, stream closed unless feedback is pending
```

The agent "loops until done" because it is a full Claude Code harness: it keeps calling tools (edit, run tests, push, deploy, read logs, fix) until it decides the request is complete. `AGENT_MAX_TURNS` and `AGENT_MAX_BUDGET_USD` bound a single run. Sessions are persisted under `DATA_DIR/agent-home`, so feedback hours later resumes with full context.

## Security boundaries

1. **`main` protection is enforced by Azure DevOps**, not by the agent's good behaviour. The agent's git identity (`ADO_AGENT_GIT_PAT`) has no bypass permission. A `PreToolUse` hook additionally denies pushes to main, force pushes, `kubectl`/`az`/`helm` and touching git credentials, so mistakes fail fast with an explanation.
2. **Platform credentials stay in the server process.** The agent subprocess gets a minimal environment (no `ADO_ADMIN_PAT`, no kubeconfig). Cluster and ADO admin actions go only through the `mcp__blackbox__*` tools, which only target the app's own repo and `bb-*` namespaces.
3. **Shell sandbox** (`AGENT_SANDBOX=true`): bash runs under bubblewrap with writes limited to the workspace and `/tmp`, and reads of the platform DB / kubeconfig denied.
4. **Cluster isolation:** one namespace per environment with quota, limit range and a NetworkPolicy; pods have no service-account token; environments expire.

### Hardening for production
- Run agent sessions in **separate worker pods** (one per run, same image, workspace on a PVC or re-cloned) so a compromised session cannot reach the API process. The runner is already isolated behind `startRun`, so it maps directly to a job queue.
- Use a **ValidatingAdmissionPolicy** so the `blackbox` service account can only write to namespaces labelled `app.kubernetes.io/managed-by=asterius-blackbox`.
- Map Entra users to Azure DevOps identities so PR reviewers are the right people (SSO itself is in place).
- Egress-restrict environment namespaces if the generated apps must not call out.

## Event types (SSE / `GET /api/apps/:id/events`)

`app.updated` · `message.created` · `run.started` · `run.finished` · `progress` (phase, title, detail, step/totalSteps) · `activity` (kind, title, detail, todos) · `env.updated` · `pr.updated` · `notification` (level, title, message, link)
