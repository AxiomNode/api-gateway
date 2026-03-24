import "dotenv/config";

import cors from "@fastify/cors";
import Fastify from "fastify";

import { loadConfig } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { proxyRoutes } from "./routes/proxy.js";

async function buildServer() {
  const config = loadConfig();
  const app = Fastify({ logger: true });

  const allowedOrigins = config.ALLOWED_ORIGINS.split(",").map((v) => v.trim());
  await app.register(cors, {
    origin: allowedOrigins,
    methods: ["GET", "HEAD", "POST", "PATCH", "OPTIONS"],
  });

  await healthRoutes(app);
  await proxyRoutes(app, config);

  return { app, config };
}

async function main() {
  const { app, config } = await buildServer();
  await app.listen({ host: "0.0.0.0", port: config.SERVICE_PORT });
  app.log.info({ service: config.SERVICE_NAME }, "Gateway started");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
