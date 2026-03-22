import { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    return { status: "ok", service: "api-gateway" };
  });

  app.get("/v1/health", async () => {
    return { status: "ok", version: "v1" };
  });
}
