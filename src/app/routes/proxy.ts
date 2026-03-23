import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildUrl, forwardHttp } from "@axiomnode/shared-sdk-client/proxy";

import type { AppConfig } from "../config.js";

function checkEdgeAuth(request: FastifyRequest, reply: FastifyReply, edgeApiToken: string): boolean {
  if (!edgeApiToken) {
    return true;
  }

  const authorization = request.headers.authorization;
  const expected = `Bearer ${edgeApiToken}`;

  if (authorization !== expected) {
    reply.code(401).send({ error: "Unauthorized" });
    return false;
  }

  return true;
}

async function forwardRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  targetUrl: string,
  method: "GET" | "POST",
): Promise<void> {
  const result = await forwardHttp({
    targetUrl,
    method,
    requestHeaders: request.headers as Record<string, string | undefined>,
    body: request.body,
  });

  reply.code(result.status);
  reply.header("content-type", result.contentType);
  reply.send(result.payload);
}

export async function proxyRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  app.get("/v1/mobile/games/quiz/random", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_MOBILE_URL, "/v1/mobile/games/quiz/random", request.query as Record<string, unknown>);
    await forwardRequest(request, reply, url, "GET");
  });

  app.get("/v1/mobile/games/wordpass/random", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_MOBILE_URL, "/v1/mobile/games/wordpass/random", request.query as Record<string, unknown>);
    await forwardRequest(request, reply, url, "GET");
  });

  app.post("/v1/mobile/games/quiz/generate", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_MOBILE_URL, "/v1/mobile/games/quiz/generate", {});
    await forwardRequest(request, reply, url, "POST");
  });

  app.post("/v1/mobile/games/wordpass/generate", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_MOBILE_URL, "/v1/mobile/games/wordpass/generate", {});
    await forwardRequest(request, reply, url, "POST");
  });

  app.get("/v1/backoffice/users/leaderboard", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/users/leaderboard", request.query as Record<string, unknown>);
    await forwardRequest(request, reply, url, "GET");
  });

  app.get("/v1/backoffice/monitor/stats", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/monitor/stats", request.query as Record<string, unknown>);
    await forwardRequest(request, reply, url, "GET");
  });
}
