# api-gateway

Single edge gateway for AxiomNode public traffic.

## Responsibilities

- Expose a unified entry point for mobile and backoffice clients.
- Apply edge concerns: auth, CORS, rate limits, and request tracing.
- Route requests to channel-specific BFF services.

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
