import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CircuitBreaker, CircuitBreakerOpenError, buildUrl, forwardHttp } from "@axiomnode/shared-sdk-client/proxy";
import { LeaderboardQuerySchema, RandomGameQuerySchema } from "@axiomnode/shared-sdk-client/contracts";

import type { AppConfig } from "../config.js";

/** @module proxy — Reverse-proxy routes forwarding requests to BFF-Mobile and BFF-Backoffice with circuit breakers. */

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

const breakers = new Map<string, CircuitBreaker>();

function getBreakerForUrl(baseUrl: string): CircuitBreaker {
  let breaker = breakers.get(baseUrl);
  if (!breaker) {
    breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 });
    breakers.set(baseUrl, breaker);
  }
  return breaker;
}

function sendValidationError(reply: FastifyReply, error: { flatten: () => unknown }): FastifyReply {
  return reply.code(400).send({
    message: "Invalid query parameters",
    errors: error.flatten(),
  });
}

async function forwardRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  targetUrl: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  timeoutMs: number,
  breaker: CircuitBreaker,
): Promise<void> {
  try {
    const result = await breaker.call(() =>
      forwardHttp({
        targetUrl,
        method,
        requestHeaders: request.headers as Record<string, string | undefined>,
        body: request.body,
        timeoutMs,
      }),
    );

    reply.code(result.status);
    reply.header("content-type", result.contentType);
    reply.send(result.payload);
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      reply.code(503).send({ error: "Service temporarily unavailable" });
      return;
    }
    throw error;
  }
}

/** Registers all gateway proxy routes that forward to downstream BFF services. */
export async function proxyRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const upstreamTimeoutMs = config.UPSTREAM_TIMEOUT_MS ?? 15000;
  const upstreamGenerationTimeoutMs = config.UPSTREAM_GENERATION_TIMEOUT_MS ?? 60000;
  const mobileBreaker = getBreakerForUrl(config.BFF_MOBILE_URL);
  const backofficeBreaker = getBreakerForUrl(config.BFF_BACKOFFICE_URL);

  app.post("/v1/backoffice/auth/session", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/auth/session", {});
    await forwardRequest(request, reply, url, "POST", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/auth/me", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/auth/me", {});
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/mobile/games/quiz/random", async (request, reply) => {
    const parsedQuery = RandomGameQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      return sendValidationError(reply, parsedQuery.error);
    }

    const url = buildUrl(config.BFF_MOBILE_URL, "/v1/mobile/games/quiz/random", parsedQuery.data);
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, mobileBreaker);
  });

  app.get("/v1/mobile/games/wordpass/random", async (request, reply) => {
    const parsedQuery = RandomGameQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      return sendValidationError(reply, parsedQuery.error);
    }

    const url = buildUrl(config.BFF_MOBILE_URL, "/v1/mobile/games/wordpass/random", parsedQuery.data);
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, mobileBreaker);
  });

  app.post("/v1/mobile/games/quiz/generate", async (request, reply) => {
    const url = buildUrl(config.BFF_MOBILE_URL, "/v1/mobile/games/quiz/generate", {});
    await forwardRequest(request, reply, url, "POST", upstreamGenerationTimeoutMs, mobileBreaker);
  });

  app.post("/v1/mobile/games/wordpass/generate", async (request, reply) => {
    const url = buildUrl(config.BFF_MOBILE_URL, "/v1/mobile/games/wordpass/generate", {});
    await forwardRequest(request, reply, url, "POST", upstreamGenerationTimeoutMs, mobileBreaker);
  });

  app.get("/v1/backoffice/users/leaderboard", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const parsedQuery = LeaderboardQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      return sendValidationError(reply, parsedQuery.error);
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/users/leaderboard", parsedQuery.data);
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/monitor/stats", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/monitor/stats", request.query as Record<string, unknown>);
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.post("/v1/backoffice/users/events/manual", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/users/events/manual", {});
    await forwardRequest(request, reply, url, "POST", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/admin/users/roles", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/admin/users/roles", {});
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.patch("/v1/backoffice/admin/users/roles/:firebaseUid", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { firebaseUid: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/admin/users/roles/${encodeURIComponent(params.firebaseUid)}`,
      {},
    );
    await forwardRequest(request, reply, url, "PATCH", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/services", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/services", {});
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/services/:service/metrics", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/metrics`,
      request.query as Record<string, unknown>,
    );
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/services/:service/logs", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/logs`,
      request.query as Record<string, unknown>,
    );
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/services/:service/data", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/data`,
      request.query as Record<string, unknown>,
    );
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/services/:service/catalogs", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/catalogs`,
      {},
    );
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.post("/v1/backoffice/services/:service/data", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/data`,
      {},
    );
    await forwardRequest(request, reply, url, "POST", upstreamTimeoutMs, backofficeBreaker);
  });

  app.delete("/v1/backoffice/services/:service/data/:entryId", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string; entryId: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/data/${encodeURIComponent(params.entryId)}`,
      request.query as Record<string, unknown>,
    );
    await forwardRequest(request, reply, url, "DELETE", upstreamTimeoutMs, backofficeBreaker);
  });
}
