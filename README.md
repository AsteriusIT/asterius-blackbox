# Asterius AI Blackbox

Describe an application in a chat; developers and business users alike. A two-step AI agent built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) does the work. A **planner** (Claude Opus 5.5 by default) understands the request, shares a plain-language plan, delegates, reviews and delivers. A **coder** subagent (Claude Sonnet 5.5 by default) writes the code and tests, then commits and pushes. Together they:

1. **creates an Azure DevOps repository** and locks `main` with branch policies (min. reviewers, comment resolution, squash-only, optional required reviewer, and build validation once CI exists). Direct pushes to `main` are rejected server-side.
2. **implements it in a loop** on feature branches: it plans, codes, tests, pushes and opens pull requests, and keeps going until the request is done and verified.
3. **deploys test environments to Kubernetes**: it builds the branch's Dockerfile in-cluster (Kaniko) and deploys it to an isolated namespace with a public URL. Optional Postgres/Redis addons are available, and environments expire after a TTL.
4. **keeps you informed** while it works: a phase stepper, a live activity timeline, the current plan, PR and environment cards. You get toasts, browser notifications and an optional Teams/Slack webhook when an environment is ready or the agent finishes.
5. **takes feedback** in the chat, either while it works (folded into the running session) or after it finishes (the same agent session is resumed, so it remembers everything).

```
┌──────────── Web (React) ─────────────┐   SSE    ┌────────────── Server (Fastify) ───────────────┐
│ apps · chat · activity · envs · PRs  │◀────────▶│ REST + event bus (SQLite)                     │
└──────────────────────────────────────┘          │ Agent runner ── Claude Agent SDK (per app)    │
                                                  │   ├─ built-in tools: files, bash, git, tests  │
                                                  │   └─ mcp__blackbox__* platform tools ─────────┼─▶ Azure DevOps REST (PRs, policies, CI)
                                                  │        report_progress / notify_user          │
                                                  │        deploy_environment / logs / status ────┼─▶ Kubernetes API (Kaniko, Deploy, Ingress)
                                                  └───────────────────────────────────────────────┘
```

## Quick start (local, no Azure)

```bash
cp .env.example .env          # set ANTHROPIC_API_KEY; keep GIT_PROVIDER=local
npm install
npm run dev                   # web on http://localhost:5173, API on :8080
```

`GIT_PROVIDER=local` creates bare repos under `data/git/` with a pre-receive hook that rejects pushes to `main`, so you can watch the whole loop (branches, protected main, PRs) offline.

### With a local Kubernetes cluster (previews on your machine)

Requires Docker, [kind](https://kind.sigs.k8s.io) and kubectl.

```bash
scripts/local-cluster.sh up   # kind cluster "blackbox" + ingress-nginx on host port 80, prints the .env settings
# paste the printed K8S_* lines into .env, then
npm run dev
```

Previews are built with your local Docker from the exact pushed commit, loaded with `kind load`, and served at `http://<app>-<env>.localtest.me` (`*.localtest.me` resolves to 127.0.0.1). The script uses its own kubeconfig (`data/kubeconfig-local`), so your default kube context is untouched. Port 80 taken? Use `HTTP_PORT=8088 scripts/local-cluster.sh up` (it sets `K8S_PUBLIC_PORT`). Other local clusters work too: set `K8S_IMAGE_LOAD=k3d|minikube`, or `none` for Docker Desktop / OrbStack / Rancher Desktop, which share Docker's image store. `scripts/local-cluster.sh down` removes everything.

## Sign-in with Microsoft Entra ID (SSO)

```bash
az login                                  # an account allowed to register apps in your tenant
scripts/entra-app.sh                      # creates "Asterius Blackbox" + secret, writes ENTRA_* and AUTH_PROVIDERS=entra to .env
PUBLIC_URL=https://blackbox.example.com scripts/entra-app.sh   # later: add the production redirect URI
```

- **Flow:** OpenID Connect authorization code + PKCE, confidential client (single tenant). The server exchanges the code, verifies the ID token (signature via the tenant's JWKS, issuer, audience, nonce, tenant) and issues its own session. Microsoft tokens never reach the browser.
- **Accounts:** users are keyed by `tenant id + object id`, never linked to local accounts by email.
- **Providers:** `AUTH_PROVIDERS=entra` shows only "Continue with Microsoft". Use `local,entra` to also keep email/password.
- **Restricting access:** `ASSIGNMENT_REQUIRED=1 scripts/entra-app.sh` limits sign-in to the users and groups assigned to the enterprise application.
- **Consent:** without admin consent, each user approves the basic profile permissions (openid, profile, email, User.Read) on first sign-in. An admin can grant consent once in the portal.
- **Secret rotation:** `ROTATE_SECRET=1 scripts/entra-app.sh` creates a new one-year secret. Never commit `.env`.

## Port (developer portal)

Blackbox publishes every application, its preview environments and its live status to [Port](https://port.io). It also creates a `service` per app, so your scorecards and DORA metrics apply to generated apps. The planner reads your production-readiness scorecards and the existing catalog while planning. Self-service actions (create an app or send feedback from Port) are implemented and switch on once Port can reach Blackbox. See [deploy/port/README.md](deploy/port/README.md).

## The agent: plan, then code

| | Model (env) | Role | Tools |
|---|---|---|---|
| **Planner / lead** | `AGENT_PLANNER_MODEL` = `claude-opus-5-5`, effort `AGENT_PLANNER_EFFORT` = `high` | Understands the request, asks only blocking questions, shares the plan (`share_plan`), delegates each step, verifies results, opens PRs, deploys previews, answers feedback | Read/Glob/Grep, Bash (inspect & verify), Agent, TodoWrite, platform tools. **No file editing.** |
| **Coder** (subagent) | `AGENT_CODER_MODEL` = `claude-sonnet-5-5`, effort `AGENT_CODER_EFFORT` = `medium` | Implements one step on its branch: code + tests, runs build/tests/linters, commits, pushes, reports precisely | Read/Write/Edit, Bash, Glob/Grep, `report_progress` |

Set `AGENT_REQUIRE_PLAN_APPROVAL=true` to make the planner wait for the user's go after sharing the plan.

## Azure DevOps

| Setting | Notes |
|---|---|
| `ADO_ORG_URL`, `ADO_PROJECT` | Target organization and project. |
| `ADO_ADMIN_PAT` | Platform identity: creates repos, policies, pipelines and PRs. **Never given to the agent.** Scopes: Code (Read, write & manage), Build (Read & execute), Project and team (Read). |
| `ADO_AGENT_GIT_PAT` | Identity used by the agent's `git push`. Scope: Code (Read & write) only. That user/service principal **must not** have *Bypass policies when pushing* or *Force push*. This is what makes the main protection real. |
| `ADO_MIN_REVIEWERS`, `ADO_REQUIRED_REVIEWER_ID` | Review gate on `main`. The PR author's vote never counts. |
| `ADO_BUILD_VALIDATION` | When the agent adds `azure-pipelines.yml` it calls `enable_ci`, which registers the pipeline and makes it a required check. |

## GitHub

`GIT_PROVIDER=github` creates private repositories under `GITHUB_OWNER` (organization or user). `main` is protected by a repository ruleset: pull request with `GITHUB_MIN_REVIEWERS` approvals (stale approvals dismissed), resolved conversations, squash only, no force-push or deletion. `enable_ci` makes the GitHub Actions job `ci` (`.github/workflows/ci.yml`) a required check. As with Azure DevOps there are two tokens: `GITHUB_ADMIN_TOKEN` for the platform, and `GITHUB_AGENT_TOKEN` (Contents read/write only, never a ruleset bypass actor) for the agent's `git push`. PR reviewers are resolved from people's public GitHub emails (best effort).

## Kubernetes test environments (production)

Prerequisites: an ingress controller, a wildcard DNS `*.preview.example.com` pointing at it, a registry (ACR attached to AKS works without pull secrets), and optionally cert-manager.

The Helm chart (below) creates the `blackbox-builds` namespace, the RBAC and the admission policy. Then:

```bash
kubectl -n blackbox-builds create secret docker-registry registry-push \
  --docker-server=myregistry.azurecr.io --docker-username=<sp-id> --docker-password=<sp-secret>
```

For each environment, the platform:
- builds `git://…#refs/heads/<branch>#<sha>` with Kaniko in `blackbox-builds`, then pushes `<registry>/<app>:<branch>-<sha>`;
- applies a namespace `bb-<app>-<env>` with a ResourceQuota, a LimitRange and a NetworkPolicy (ingress controller + same namespace only), optional Postgres/Redis, then the Deployment, Service and Ingress;
- waits for the rollout and fails fast on CrashLoopBackOff or image pull errors, returning logs so the agent can fix and retry;
- notifies the user with the URL, and deletes the namespace after `K8S_ENV_TTL_HOURS`.

## Deploying Blackbox itself

CI publishes `ghcr.io/asteriusit/asterius-blackbox` on every push to `main`. Deploy with the Helm chart in [deploy/helm/blackbox](deploy/helm/blackbox) (values for ADO, Kubernetes, Port and Entra in `values.yaml`):

```bash
kubectl create namespace blackbox-system
kubectl -n blackbox-system create secret generic blackbox-secrets \
  --from-literal=ANTHROPIC_API_KEY=... --from-literal=ADO_ADMIN_PAT=... --from-literal=ADO_AGENT_GIT_PAT=... \
  --from-literal=ENTRA_CLIENT_SECRET=...
helm upgrade --install blackbox deploy/helm/blackbox -n blackbox-system \
  --set existingSecret=blackbox-secrets --set publicUrl=https://blackbox.example.com --set ingress.host=blackbox.example.com \
  --set auth.entra.tenantId=... --set auth.entra.clientId=...
```

- **Single pod** (default): API + agent sessions in one process, SQLite on a ReadWriteOnce volume.
- **Scaled**: `--set database.url=postgres://… --set workers.enabled=true --set persistence.accessMode=ReadWriteMany`. Then the API (`api.replicas`) and the agent workers (`workers.replicas` × `workers.concurrency` sessions) scale independently, and a compromised agent session cannot reach the API process.

### Backups

```bash
scripts/backup.sh backup            # → backups/blackbox-<timestamp>.tar.gz (DB snapshot or pg_dump, agent sessions, local repos, attachments, secrets key)
scripts/backup.sh restore <archive> # stop Blackbox first; the current DATA_DIR is moved aside
```

The SQLite snapshot is safe while Blackbox runs. With Postgres, `pg_dump`/`pg_restore` must match the server's major version (`PG_DUMP=… PG_RESTORE=…` to override). Workspaces are not backed up: they are re-cloned on demand.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the agent loop, the event model and the security boundaries.
