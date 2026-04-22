# Architecture

## Scope

This section documents the repository-local architecture of `api-gateway`.

It should describe:

- TLS termination and edge auth integration
- routing toward BFF services and internal AI routes
- cross-cutting ingress concerns owned here

## Runtime position

`api-gateway` is the single public ingress for AxiomNode runtime traffic.

It sits between public clients and private internal services. It should be the only repository in this runtime slice that exposes internet-facing application routes directly.

## Owned architectural responsibilities

- enforce edge authentication and request admission rules
- apply CORS and ingress-level request shaping
- forward mobile traffic to `bff-mobile`
- forward backoffice traffic to `bff-backoffice`
- expose stable internal AI proxy routes regardless of the active AI upstream target

## Downstream dependency model

Primary downstream dependencies:

- `bff-mobile`
- `bff-backoffice`
- active `ai-engine-api` target
- active `ai-engine-stats` target

The gateway should not absorb domain business logic from quiz, word-pass, or users services.

## Effective target model

The architecture has two layers of target resolution:

1. environment defaults for BFF and AI upstreams
2. persisted runtime override for the active AI target

This means a valid deployment does not by itself guarantee a valid effective AI topology.

## Request flow summary

1. public client calls `api-gateway`
2. gateway validates edge token and request constraints
3. gateway selects route family
4. gateway forwards to the correct BFF or internal AI upstream target
5. gateway returns normalized upstream status and payload shape to the caller

## Failure boundaries

- edge auth rejects the request before forwarding
- BFF target is unreachable or unhealthy
- internal AI routes point to stale or invalid runtime target state
- gateway-level timeout is reached before downstream completion

## When to update

Update this section when changing route ownership, forwarding behavior, timeout policy, or gateway-managed runtime targeting.
