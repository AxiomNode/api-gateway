# Guides

## Scope

This section groups repository-local guidance for evolving `api-gateway` safely.

## Route evolution rules

- add new public client routes only when they belong at the stable edge boundary
- prefer forwarding and normalization over duplicating downstream business rules
- keep client-visible route semantics stable even if BFF or service internals change

## Internal AI route rules

- keep internal AI route paths stable for producer and operator consumers
- separate AI API versus AI stats targets explicitly
- document whether a change affects environment defaults, persisted runtime target behavior, or both

## Intended topics

- public route evolution
- internal AI route compatibility
- versioning strategy at the gateway boundary

## Compatibility checklist

Before changing gateway routes, verify:

1. which caller owns the route today
2. whether the route is public, internal, or operator-facing
3. whether auth or header propagation behavior changes
4. whether the change belongs here or in a BFF instead
