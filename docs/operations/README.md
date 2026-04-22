# Operations

## Scope

This section groups repository-local operational notes for `api-gateway`.

## Run locally

1. `cd src`
2. `cp .env.example .env`
3. From the private `secrets` repository, run `node scripts/prepare-runtime-secrets.mjs dev` to generate `src/.env.secrets`
4. `npm install`
5. `npm run dev`

## Operational checks

After startup, validate:

- `GET /health`
- one mobile route through `bff-mobile`
- one backoffice route through `bff-backoffice`
- `GET /internal/ai-engine/health` when AI routing is expected to be available

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
