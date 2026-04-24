import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  UpstreamTimeoutError,
  buildUrl,
  extractForwardHeaders,
  forwardHttp,
} from "@axiomnode/shared-sdk-client/proxy";
import { LeaderboardQuerySchema, RandomGameQuerySchema } from "@axiomnode/shared-sdk-client/contracts";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import { RoutingStateStore } from "../services/routingStateStore.js";

/** @module proxy — Reverse-proxy routes forwarding requests to BFF-Mobile and BFF-Backoffice with circuit breakers. */

const AiEngineTargetSchema = z.object({
  host: z.string().trim().min(1).max(255),
  protocol: z.enum(["http", "https"]).default("http"),
  apiPort: z.coerce.number().int().min(1).max(65535).default(7001),
  statsPort: z.coerce.number().int().min(1).max(65535).default(7000),
  label: z.string().trim().max(80).optional(),
});

function normalizeAiEngineHost(raw: string): string {
  const trimmed = raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const withoutPath = trimmed.split("/")[0] ?? "";
  const withoutPort = withoutPath.replace(/:\d+$/, "");

  if (!withoutPort || !/^[a-zA-Z0-9.-]+$/.test(withoutPort)) {
    throw new Error("host must be a valid hostname or IPv4 address");
  }

  return withoutPort;
}

function buildAiEngineBaseUrl(protocol: "http" | "https", host: string, port: number): string {
  return `${protocol}://${host}:${port}`;
}

function parseBaseUrl(url: string): {
  host: string | null;
  protocol: "http" | "https" | null;
  port: number | null;
} {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol === "https:" ? "https" : parsed.protocol === "http:" ? "http" : null;
    const fallbackPort = protocol === "https" ? 443 : protocol === "http" ? 80 : NaN;
    const parsedPort = parsed.port ? Number(parsed.port) : fallbackPort;

    return {
      host: parsed.hostname || null,
      protocol,
      port: Number.isFinite(parsedPort) ? parsedPort : null,
    };
  } catch {
    return {
      host: null,
      protocol: null,
      port: null,
    };
  }
}

function getAiEngineApiBaseUrl(config: AppConfig, routingStore: RoutingStateStore): string {
  return routingStore.get("ai-engine-api")?.baseUrl ?? config.AI_ENGINE_API_URL ?? "http://localhost:7001";
}

function getAiEngineStatsBaseUrl(config: AppConfig, routingStore: RoutingStateStore): string {
  return routingStore.get("ai-engine-stats")?.baseUrl ?? config.AI_ENGINE_STATS_URL ?? "http://localhost:7000";
}

function getAiEngineTarget(config: AppConfig, routingStore: RoutingStateStore) {
  const apiBaseUrl = getAiEngineApiBaseUrl(config, routingStore);
  const statsBaseUrl = getAiEngineStatsBaseUrl(config, routingStore);
  const apiParsed = parseBaseUrl(apiBaseUrl);
  const statsParsed = parseBaseUrl(statsBaseUrl);
  const apiOverride = routingStore.get("ai-engine-api");
  const statsOverride = routingStore.get("ai-engine-stats");
  const activeOverride = apiOverride ?? statsOverride;

  return {
    source: activeOverride ? ("override" as const) : ("env" as const),
    label: activeOverride?.label ?? null,
    host: apiParsed.host ?? statsParsed.host,
    protocol: apiParsed.protocol ?? statsParsed.protocol,
    apiPort: apiParsed.port,
    statsPort: statsParsed.port,
    apiBaseUrl,
    statsBaseUrl,
    updatedAt: activeOverride?.updatedAt ?? null,
  };
}

async function applyAiEngineTarget(config: AppConfig, routingStore: RoutingStateStore, input: z.infer<typeof AiEngineTargetSchema>): Promise<void> {
  const host = normalizeAiEngineHost(input.host);
  const label = input.label?.trim() || undefined;
  const updatedAt = new Date().toISOString();

  await routingStore.set("ai-engine-api", {
    baseUrl: buildAiEngineBaseUrl(input.protocol, host, input.apiPort),
    label,
    updatedAt,
  });
  await routingStore.set("ai-engine-stats", {
    baseUrl: buildAiEngineBaseUrl(input.protocol, host, input.statsPort),
    label,
    updatedAt,
  });
}

async function resetAiEngineTarget(routingStore: RoutingStateStore): Promise<void> {
  await routingStore.delete("ai-engine-api");
  await routingStore.delete("ai-engine-stats");
}

function isGatewayAdminAuthorized(request: FastifyRequest, config: AppConfig): boolean {
  const token = config.API_GATEWAY_ADMIN_TOKEN?.trim();
  if (!token) {
    return true;
  }

  return request.headers.authorization === `Bearer ${token}`;
}

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
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  timeoutMs: number,
  breaker: CircuitBreaker,
): Promise<void> {
  try {
    const result = await breaker.call(async () => {
      if (method !== "PUT") {
        return forwardHttp({
          targetUrl,
          method,
          requestHeaders: request.headers as Record<string, string | undefined>,
          body: request.body,
          timeoutMs,
        });
      }

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(targetUrl, {
          method,
          headers: extractForwardHeaders(request.headers as Record<string, string | undefined>, true),
          body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
          signal: controller.signal,
        });
        const contentType = response.headers.get("content-type") ?? "application/json";
        const payload = contentType.includes("application/json")
          ? await response.json().catch(() => ({}))
          : await response.text();

        return {
          status: response.status,
          contentType,
          payload,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new UpstreamTimeoutError(`Upstream request timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }
    });

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
  const routingStore = new RoutingStateStore(config);
  await routingStore.load();

  app.get("/internal/admin/ai-engine/target", async (request, reply) => {
    if (!isGatewayAdminAuthorized(request, config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    return reply.send(getAiEngineTarget(config, routingStore));
  });

  app.put("/internal/admin/ai-engine/target", async (request, reply) => {
    if (!isGatewayAdminAuthorized(request, config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const parsed = AiEngineTargetSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid payload", errors: parsed.error.flatten() });
    }

    try {
      await applyAiEngineTarget(config, routingStore, parsed.data);
      return reply.send(getAiEngineTarget(config, routingStore));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "Invalid ai-engine target" });
    }
  });

  app.delete("/internal/admin/ai-engine/target", async (request, reply) => {
    if (!isGatewayAdminAuthorized(request, config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    await resetAiEngineTarget(routingStore);
    return reply.send(getAiEngineTarget(config, routingStore));
  });

  app.post("/internal/ai-engine/generate/quiz", async (request, reply) => {
    const url = buildUrl(getAiEngineApiBaseUrl(config, routingStore), "/generate/quiz", request.query as Record<string, unknown>);
    await forwardRequest(request, reply, url, "POST", upstreamGenerationTimeoutMs, getBreakerForUrl(getAiEngineApiBaseUrl(config, routingStore)));
  });

  app.post("/internal/ai-engine/generate/word-pass", async (request, reply) => {
    const url = buildUrl(getAiEngineApiBaseUrl(config, routingStore), "/generate/word-pass", request.query as Record<string, unknown>);
    await forwardRequest(request, reply, url, "POST", upstreamGenerationTimeoutMs, getBreakerForUrl(getAiEngineApiBaseUrl(config, routingStore)));
  });

  app.post("/internal/ai-engine/ingest/quiz", async (request, reply) => {
    const url = buildUrl(getAiEngineApiBaseUrl(config, routingStore), "/ingest/quiz", {});
    await forwardRequest(request, reply, url, "POST", upstreamGenerationTimeoutMs, getBreakerForUrl(getAiEngineApiBaseUrl(config, routingStore)));
  });

  app.post("/internal/ai-engine/ingest/word-pass", async (request, reply) => {
    const url = buildUrl(getAiEngineApiBaseUrl(config, routingStore), "/ingest/word-pass", {});
    await forwardRequest(request, reply, url, "POST", upstreamGenerationTimeoutMs, getBreakerForUrl(getAiEngineApiBaseUrl(config, routingStore)));
  });

  app.get("/internal/ai-engine/catalogs", async (request, reply) => {
    const url = buildUrl(getAiEngineApiBaseUrl(config, routingStore), "/catalogs", {});
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, getBreakerForUrl(getAiEngineApiBaseUrl(config, routingStore)));
  });

  app.get("/internal/ai-engine/health", async (request, reply) => {
    const url = buildUrl(getAiEngineApiBaseUrl(config, routingStore), "/health", {});
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, getBreakerForUrl(getAiEngineApiBaseUrl(config, routingStore)));
  });

  app.get("/internal/ai-engine/stats", async (request, reply) => {
    const url = buildUrl(getAiEngineStatsBaseUrl(config, routingStore), "/stats", request.query as Record<string, unknown>);
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, getBreakerForUrl(getAiEngineStatsBaseUrl(config, routingStore)));
  });

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

  app.get("/v1/backoffice/services/operational-summary", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/services/operational-summary", {});
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/ai-engine/target", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/ai-engine/target", {});
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.put("/v1/backoffice/ai-engine/target", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/ai-engine/target", {});
    await forwardRequest(request, reply, url, "PUT", upstreamTimeoutMs, backofficeBreaker);
  });

  app.delete("/v1/backoffice/ai-engine/target", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/ai-engine/target", {});
    await forwardRequest(request, reply, url, "DELETE", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/ai-engine/presets", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/ai-engine/presets", {});
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.post("/v1/backoffice/ai-engine/presets", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/ai-engine/presets", {});
    await forwardRequest(request, reply, url, "POST", upstreamTimeoutMs, backofficeBreaker);
  });

  app.put("/v1/backoffice/ai-engine/presets/:presetId", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { presetId: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/ai-engine/presets/${encodeURIComponent(params.presetId)}`,
      {},
    );
    await forwardRequest(request, reply, url, "PUT", upstreamTimeoutMs, backofficeBreaker);
  });

  app.delete("/v1/backoffice/ai-engine/presets/:presetId", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { presetId: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/ai-engine/presets/${encodeURIComponent(params.presetId)}`,
      {},
    );
    await forwardRequest(request, reply, url, "DELETE", upstreamTimeoutMs, backofficeBreaker);
  });

  app.post("/v1/backoffice/ai-engine/probe", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/ai-engine/probe", {});
    await forwardRequest(request, reply, url, "POST", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/ai-diagnostics/rag/stats", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/ai-diagnostics/rag/stats", {});
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.post("/v1/backoffice/ai-diagnostics/tests/run", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/ai-diagnostics/tests/run", {});
    await forwardRequest(request, reply, url, "POST", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/ai-diagnostics/tests/status", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/ai-diagnostics/tests/status", {});
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/service-targets", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const url = buildUrl(config.BFF_BACKOFFICE_URL, "/v1/backoffice/service-targets", {});
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.put("/v1/backoffice/service-targets/:service", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/service-targets/${encodeURIComponent(params.service)}`,
      {},
    );
    await forwardRequest(request, reply, url, "PUT", upstreamTimeoutMs, backofficeBreaker);
  });

  app.delete("/v1/backoffice/service-targets/:service", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/service-targets/${encodeURIComponent(params.service)}`,
      {},
    );
    await forwardRequest(request, reply, url, "DELETE", upstreamTimeoutMs, backofficeBreaker);
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

  app.patch("/v1/backoffice/services/:service/data/:entryId", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string; entryId: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/data/${encodeURIComponent(params.entryId)}`,
      {},
    );
    await forwardRequest(request, reply, url, "PATCH", upstreamTimeoutMs, backofficeBreaker);
  });

  app.post("/v1/backoffice/services/:service/generation/process", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/generation/process`,
      {},
    );
    await forwardRequest(request, reply, url, "POST", upstreamTimeoutMs, backofficeBreaker);
  });

  app.post("/v1/backoffice/services/:service/generation/wait", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/generation/wait`,
      {},
    );
    await forwardRequest(request, reply, url, "POST", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/services/:service/generation/processes", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/generation/processes`,
      request.query as Record<string, unknown>,
    );
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/services/:service/generation/process/:taskId", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string; taskId: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/generation/process/${encodeURIComponent(params.taskId)}`,
      request.query as Record<string, unknown>,
    );
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.get("/v1/backoffice/services/:service/generation/worker", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/generation/worker`,
      {},
    );
    await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, backofficeBreaker);
  });

  app.post("/v1/backoffice/services/:service/generation/worker/start", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/generation/worker/start`,
      {},
    );
    await forwardRequest(request, reply, url, "POST", upstreamTimeoutMs, backofficeBreaker);
  });

  app.post("/v1/backoffice/services/:service/generation/worker/stop", async (request, reply) => {
    if (!checkEdgeAuth(request, reply, config.EDGE_API_TOKEN)) {
      return;
    }

    const params = request.params as { service: string };
    const url = buildUrl(
      config.BFF_BACKOFFICE_URL,
      `/v1/backoffice/services/${encodeURIComponent(params.service)}/generation/worker/stop`,
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
