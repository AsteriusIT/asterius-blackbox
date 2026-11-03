# Port integration

| Direction | What | Needs Blackbox reachable by Port? | Status |
|---|---|---|---|
| Blackbox → Port | Catalog sync: `service`, `blackboxApplication`, `previewEnvironment` | No (outbound) | **On** when `PORT_CLIENT_ID`/`PORT_CLIENT_SECRET` are set |
| Blackbox → Port | Planner tools `port_production_standards`, `port_find_services` (read-only) | No (outbound) | **On** with credentials (`PORT_AGENT_CONTEXT=false` to disable) |
| Port → Blackbox | Self-service actions (create app, feedback, stop, delete preview) | Yes, or the Port Execution Agent | Code ready, **off** (`PORT_ACTIONS_ENABLED=false`) |

## Data model (already created in the Asterius IT Port org)

- `blueprint.blackboxApplication.json`: one entity per Blackbox application (identifier = Blackbox app id). Relations to `service` and `azureDevopsRepository` (the ADO repo GUID, the same identifier the `ait-ado` integration uses).
- `blueprint.previewEnvironment.json`: one entity per live preview (identifier = environment name), related to its application.
- `service`: Blackbox upserts one service per app (identifier = app slug), with `merge=true`. Human edits such as criticality survive, and the owning team is set only on creation (the requester's Port teams, else `PORT_DEFAULT_TEAM`). This plugs generated apps into the existing scorecards (production readiness, DORA, delivery).

To recreate them in another org, POST each blueprint file to `/v1/blueprints`. Create `blackboxApplication` first, without its aggregation property (it targets `previewEnvironment`), then add the aggregation.

## Enabling the sync

1. In Port: `…` (top right) → **Credentials**, then copy the client ID and secret.
2. Add them to `.env`:
   ```
   PORT_CLIENT_ID=...
   PORT_CLIENT_SECRET=...
   # PORT_API_URL=https://api.port.io        # EU (default); US: https://api.us.port.io
   # PORT_DEFAULT_TEAM=<team identifier>     # owner when the requester has no Port team
   ```
3. Restart Blackbox. It reconciles every application at startup and every 30 minutes, and pushes changes about 3 s after each event. Sync status: `GET /api/platform` → `port`.

## Enabling self-service actions (after deployment)

1. Make `POST /api/integrations/port/webhook` reachable by Port. Either:
   - **Port Execution Agent** (recommended, no inbound traffic): deploy it in your network, set `"agent": true` in `actions.json`, and point the URL at Blackbox's internal address; or
   - expose only that path over HTTPS.
2. Replace `BLACKBOX_PUBLIC_URL` in `actions.json`, then create each action (`POST /v1/actions`, or paste the JSON in Port's action editor).
3. Set `PORT_ACTIONS_ENABLED=true` and restart.

Security:
- Every request is verified with the Port signature (`x-port-timestamp`, `x-port-signature: v1,<base64 HMAC-SHA256("<ts>.<raw body>")>` signed with `PORT_CLIENT_SECRET`), with a 5-minute replay window and a constant-time comparison.
- The triggering Port user must already have a Blackbox account (Microsoft sign-in, same work email) and must own the targeted app.
- The request body is the explicit template in `actions.json`, so Blackbox never depends on Port's default payload shape.

Progress goes back to the Port run: a link to the Blackbox chat, a log line per milestone, the preview link when it is ready, and a final SUCCESS or FAILURE when the agent finishes.
