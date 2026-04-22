# api-gateway docs

Technical documentation for the AxiomNode edge gateway.

## Purpose

This local docs folder explains the concrete implementation surface of `api-gateway`:

- edge responsibilities and ingress boundaries
- route forwarding behavior owned by this repository
- local operational workflow and gateway-managed runtime state

## Contents

- `architecture/README.md`: repository-local architecture boundary and dependency model.
- `guides/README.md`: route-shaping, integration, and versioning guidance.
- `operations/README.md`: local runbook and runtime-state operational notes.

## Reading order

1. Start with `architecture/README.md`.
2. Continue with `guides/README.md` when changing routes or forwarding behavior.
3. Use `operations/README.md` for local run and troubleshooting.

## CI/CD reference

- Repository workflow: `.github/workflows/ci.yml`.
- Push to `main` dispatches `platform-infra` image build for `api-gateway`.
