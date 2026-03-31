# api-gateway

Single entry gateway for AxiomNode.

## Purpose

- Expose a single public endpoint for the mobile app and backoffice.
- Centralize auth, rate limiting, CORS, and edge observability.
- Route traffic to BFFs and internal microservices.

## Main responsibility

- Single edge entry point for baseline security, routing, and cross-cutting policies.

## Structure

- `src/`: TypeScript source code.
- `docs/`: gateway architecture and decisions.
- `.github/workflows/ci.yml`: base pipeline (build/test/lint).

## Quick start

1. Go to `src`.
2. Copy `.env.example` to `.env`.
3. Install dependencies and start in dev mode.

## Endpoints

- `GET /health`
- `GET /v1/mobile/games/quiz/random`
- `GET /v1/mobile/games/wordpass/random`
- `POST /v1/mobile/games/quiz/generate`
- `POST /v1/mobile/games/wordpass/generate`
- `GET /v1/backoffice/users/leaderboard`
- `GET /v1/backoffice/monitor/stats`

## Key environment variables

- `ALLOWED_ORIGINS` (includes `http://localhost:7080` when backoffice runs in Docker)
- `BFF_MOBILE_URL`
- `BFF_BACKOFFICE_URL`
- `EDGE_API_TOKEN` (if set, requires `Authorization: Bearer <token>` on `/v1/*`)
