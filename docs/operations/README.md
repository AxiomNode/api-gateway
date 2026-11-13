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

Outside `NODE_ENV=development|test` the process exits at startup if any of `EDGE_API_TOKEN` or `INTERNAL_SERVICE_TOKEN` is empty. The container image sets `NODE_ENV=production`, so both must be present in the runtime secrets before rollout. Callers of `/internal/ai-engine/*` must send `x-internal-token`. Set `TRUST_PROXY` in the deployment environment.

## Operational checks

After startup, validate:

- `GET /health`
- one mobile route through `bff-mobile`
- one backoffice route through `bff-backoffice`
- `GET /internal/ai-engine/health` (with the `x-internal-token` header) when AI routing is expected to be available

## Runtime-state checks

When AI behavior is failing but the gateway process is healthy, verify:

- configured `AI_ENGINE_API_URL` and `AI_ENGINE_STATS_URL`

## Common failure patterns

- healthy gateway with broken downstream reachability
- healthy gateway with `AI_ENGINE_API_URL` or `AI_ENGINE_STATS_URL` pointing at the wrong host
- public routes passing while internal AI routes fail
- auth failures caused by token mismatch rather than downstream health
- `503` on `/internal/ai-engine/*` or edge routes means the matching token is unset in a non-development environment
