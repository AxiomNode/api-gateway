# api-gateway

Single edge gateway for AxiomNode public traffic.

## Responsibilities

- Expose a unified entry point for mobile and backoffice clients.
- Apply edge concerns: auth, CORS, rate limits, and request tracing.
- Route requests to channel-specific BFF services.
- Provide the stable internal ai-engine upstream used by cluster services when ai-engine runs externally on an optional workstation.

## Repository structure

- `src/`: Fastify + TypeScript implementation.
- `docs/`: architecture, guides, and operations notes.
- `.github/workflows/ci.yml`: repository CI and deployment dispatch trigger.

## Local development

1. `cd src`
2. `cp .env.example .env`
3. `npm install`
4. `npm run dev`

## Main routes

- `GET /health`
- `GET /v1/mobile/games/quiz/random`
- `GET /v1/mobile/games/wordpass/random`
- `POST /v1/mobile/games/quiz/generate`
- `POST /v1/mobile/games/wordpass/generate`
- `GET /v1/backoffice/users/leaderboard`
- `GET /v1/backoffice/monitor/stats`
- `POST /internal/ai-engine/generate/quiz`
- `POST /internal/ai-engine/generate/word-pass`
- `POST /internal/ai-engine/ingest/quiz`
- `POST /internal/ai-engine/ingest/word-pass`
- `GET /internal/ai-engine/catalogs`
- `GET /internal/ai-engine/health`
- `GET /internal/ai-engine/stats`
- `GET|PUT|DELETE /internal/admin/ai-engine/target`

The ai-engine target managed through `/internal/admin/ai-engine/target` is intentionally not restricted by `ALLOWED_ROUTING_TARGET_HOSTS`. That allowlist still applies to generic service-target overrides, but ai-engine must remain movable to any reachable host chosen from backoffice.

## CI/CD workflow behavior

- `ci.yml`
	- Trigger: push (`main`, `develop`), pull request, manual dispatch.
	- Job `build-test-lint`: checks out `shared-sdk-client` with `CROSS_REPO_READ_TOKEN`, blocks tracked `src/node_modules` / `src/dist`, then runs install, build, test, lint, and production `npm audit --omit=dev --audit-level=high`.
	- Job `trigger-platform-infra-build`:
		- Runs on push to `main`.
		- Dispatches `platform-infra/.github/workflows/build-push.yaml` with `service=api-gateway`.
		- Requires `PLATFORM_INFRA_DISPATCH_TOKEN` in this repo.

## Deployment automation chain

1. Push to `main` in this repo.
2. Repo CI dispatches image build in `platform-infra`.
3. `platform-infra` build publishes GHCR images.
4. `platform-infra` deploy workflow rolls out to `dev` only.

## Key environment variables

- `ALLOWED_ORIGINS`
- `BFF_MOBILE_URL`
- `BFF_BACKOFFICE_URL`
- `EDGE_API_TOKEN`
- `AI_ENGINE_API_URL`
- `AI_ENGINE_STATS_URL`
- `GATEWAY_ROUTING_STATE_FILE`
- `ALLOWED_ROUTING_TARGET_HOSTS`
- `API_GATEWAY_ADMIN_TOKEN`
