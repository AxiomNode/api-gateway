import { FastifyInstance } from "fastify";

/** @module health — Liveness and readiness health-check endpoints for the API Gateway. */

/** Registers /health and /v1/health routes returning service status. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    return { status: "ok", service: "api-gateway" };
  });

  app.get("/v1/health", async () => {
    return { status: "ok", version: "v1" };
  });
}
