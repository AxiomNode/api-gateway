# api-gateway

Gateway de entrada unico para AxiomNode.

## Objetivo

- Exponer un unico endpoint publico para app movil y backoffice.
- Centralizar auth, rate limit, CORS y observabilidad de borde.
- Enrutar trafico hacia BFFs y microservicios internos.

## Responsabilidad principal

- Punto unico de entrada edge para seguridad base, enrutado y politicas transversales.

## Estructura

- `src/`: codigo fuente TypeScript.
- `docs/`: arquitectura y decisiones del gateway.
- `.github/workflows/ci.yml`: pipeline base (build/test/lint).

## Inicio rapido

1. Ir a `src`.
2. Copiar `.env.example` a `.env`.
3. Instalar dependencias y levantar en modo dev.

## Endpoints

- `GET /health`
- `GET /v1/mobile/games/quiz/random`
- `GET /v1/mobile/games/wordpass/random`
- `POST /v1/mobile/games/quiz/generate`
- `POST /v1/mobile/games/wordpass/generate`
- `GET /v1/backoffice/users/leaderboard`
- `GET /v1/backoffice/monitor/stats`

## Variables clave

- `ALLOWED_ORIGINS` (incluye `http://localhost:7080` cuando backoffice corre en Docker)
- `BFF_MOBILE_URL`
- `BFF_BACKOFFICE_URL`
- `EDGE_API_TOKEN` (si se define, requiere `Authorization: Bearer <token>` en `/v1/*`)
