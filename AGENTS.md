# AGENTS

## Repo purpose
Edge gateway that exposes a single public entry point and routes traffic to BFF services.

## Key paths
- src/: Fastify TypeScript code
- docs/: architecture, guides, operations
- .github/workflows/ci.yml: build/test/lint + infra dispatch

## Local commands
- cd src && npm install
- cd src && npm run dev
- cd src && npm test && npm run lint && npm run build

## CI/CD notes
- Push to main dispatches platform-infra build-push with service=api-gateway.
- Deployment is manual-only via the platform-infra `deploy.yaml` workflow (the k3s staging host no longer exists, nothing auto-deploys).

## LLM editing rules
- Do not break public route contracts without docs update.
- Keep edge concerns centralized (auth, CORS, limits, tracing).
- Keep README/docs synchronized with workflow changes.
