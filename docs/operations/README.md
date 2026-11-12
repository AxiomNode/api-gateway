# Operations

Last updated: 2026-05-08.

## Scope

This section groups repository-local operational notes for `api-gateway`.

## Run locally

1. `cd src`
2. `cp .env.example .env`
3. From the private `secrets` repository, run `node scripts/prepare-runtime-secrets.mjs dev` to generate `src/.env.secrets`
4. `npm install`
5. `npm run dev`

## Required credentials

Outside `NODE_ENV=development|test` the process exits at startup if any of `EDGE_API_TOKEN`, `API_GATEWAY_ADMIN_TOKEN` or `INTERNAL_SERVICE_TOKEN` is empty. The container image sets `NODE_ENV=production`, so all three must be present in the runtime secrets before rollout. Callers of `/internal/ai-engine/*` must send `x-internal-token`. Set `TRUST_PROXY` (and `ALLOWED_ROUTING_TARGET_HOSTS` if runtime target overrides are used) in the deployment environment.

## Operational checks

After startup, validate:

- `GET /health`
- one mobile route through `bff-mobile`
- one backoffice route through `bff-backoffice`
- `GET /internal/ai-engine/health` (with the `x-internal-token` header) when AI routing is expected to be available

## Runtime-state checks

When AI behavior is failing but the gateway process is healthy, verify:

- configured `AI_ENGINE_API_URL` and `AI_ENGINE_STATS_URL`
- persisted state file at `GATEWAY_ROUTING_STATE_FILE`
- whether the effective target source is environment or override-driven

## Common failure patterns

- healthy gateway with broken downstream reachability
- healthy gateway with stale AI runtime target override
- public routes passing while internal AI routes fail
- auth failures caused by token mismatch rather than downstream health
- `503` on `/internal/ai-engine/*` or edge routes means the matching token is unset in a non-development environment
- `400 host is not in ALLOWED_ROUTING_TARGET_HOSTS` when changing the ai-engine target
