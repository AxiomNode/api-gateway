# api-gateway

Gateway de entrada unico para AxiomNode.

## Objetivo

- Exponer un unico endpoint publico para app movil y backoffice.
- Centralizar auth, rate limit, CORS y observabilidad de borde.
- Enrutar trafico hacia BFFs y microservicios internos.

## Estructura

- `src/`: codigo fuente TypeScript.
- `docs/`: arquitectura y decisiones del gateway.
- `.github/workflows/ci.yml`: pipeline base (build/test/lint).

## Inicio rapido

1. Ir a `src`.
2. Copiar `.env.example` a `.env`.
3. Instalar dependencias y levantar en modo dev.

## Endpoints base

- `GET /health`

Los endpoints funcionales por dominio se agregaran conforme avancen los BFFs y contratos.
