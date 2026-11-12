import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  buildUrl,
  forwardHttp,
} from "@axiomnode/shared-sdk-client/proxy";
import { forwardHttpRaw } from "@axiomnode/shared-sdk-client/proxy-raw";
import { LeaderboardQuerySchema } from "@axiomnode/shared-sdk-client";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import { RoutingStateStore } from "../services/routingStateStore.js";
import { bearerMatches, headerMatches, isPermissiveEnv, isTargetHostAllowed } from "../services/security.js";
import { ROUTE_TABLE, type Auth, type QueryPolicy, type TimeoutKind, type Upstream } from "./routeTable.js";

/** @module proxy — Reverse-proxy routes forwarding requests to BFF-Mobile and BFF-Backoffice with circuit breakers. */

const AiEngineTargetSchema = z.object({
  host: z.string().trim().min(1).max(255),
  protocol: z.enum(["http", "https"]).default("http"),
  apiPort: z.coerce.number().int().min(1).max(65535).default(7001),
  statsPort: z.coerce.number().int().min(1).max(65535).default(7000),
  label: z.string().trim().max(80).optional(),
});

const MobileRandomQuerySchema = z.object({
  language: z.string().optional(),
  categoryId: z.string().min(1).optional(),
  count: z.coerce.number().int().positive().max(50).optional(),
}).strict();

function omitLanguageQuery<T extends Record<string, unknown>>(query: T): Omit<T, "language"> {
  const rest = { ...query };
  delete rest.language;
  return rest;
}

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
  if (input.protocol !== "http" && input.protocol !== "https") {
    throw new Error("protocol must be http or https");
  }
  const host = normalizeAiEngineHost(input.host);
  if (!isTargetHostAllowed(host, config.ALLOWED_ROUTING_TARGET_HOSTS, config.NODE_ENV)) {
    throw new Error("host is not in ALLOWED_ROUTING_TARGET_HOSTS");
  }
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

/**
 * Fail-closed bearer check. An empty token is only tolerated in development/test
 * (a warning is logged at startup); any other NODE_ENV rejects the request.
 */
function isGatewayAdminAuthorized(request: FastifyRequest, config: AppConfig): boolean {
  const token = config.API_GATEWAY_ADMIN_TOKEN?.trim();
  if (!token) {
    return isPermissiveEnv(config.NODE_ENV);
  }

  return bearerMatches(request.headers.authorization, token);
}

function checkEdgeAuth(request: FastifyRequest, reply: FastifyReply, config: AppConfig): boolean {
  const edgeApiToken = config.EDGE_API_TOKEN?.trim();
  if (!edgeApiToken) {
    if (isPermissiveEnv(config.NODE_ENV)) {
      return true;
    }
    reply.code(503).send({ error: "Edge authentication is not configured" });
    return false;
  }

  if (!bearerMatches(request.headers.authorization, edgeApiToken)) {
    reply.code(401).send({ error: "Unauthorized" });
    return false;
  }

  return true;
}

/** Service-to-service auth for /internal/ai-engine/* via the x-internal-token header. */
function checkInternalAuth(request: FastifyRequest, reply: FastifyReply, config: AppConfig): boolean {
  const token = config.INTERNAL_SERVICE_TOKEN?.trim();
  if (!token) {
    if (isPermissiveEnv(config.NODE_ENV)) {
      return true;
    }
    reply.code(503).send({ error: "Internal service authentication is not configured" });
    return false;
  }

  if (!headerMatches(request.headers["x-internal-token"], token)) {
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

/**
 * How a hop forwards the payload:
 * - "raw" (default): request and response bodies travel as the original bytes (no JSON.parse/stringify).
 *   Only for routes where the gateway neither inspects nor modifies the body.
 * - "json": body parsed and re-serialized by the SDK helper. Kept for routes that validate input.
 */
type ForwardMode = "raw" | "json";

/** Fills `:name` segments of a route template from the (already decoded) request params, re-encoding each value. */
function fillPathParams(template: string, params: unknown): string {
  const values = (params ?? {}) as Record<string, string>;
  return template.replace(/:(\w+)/g, (_match, name: string) => encodeURIComponent(values[name] ?? ""));
}

function applyQueryPolicy(policy: QueryPolicy, query: Record<string, unknown>): Record<string, unknown> {
  switch (policy) {
    case "forward":
      return query;
    case "forward-without-language":
      return omitLanguageQuery(query);
    case "drop":
      return {};
  }
}

const BODYLESS_STATUSES = new Set([204, 205, 304]);

async function forwardRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  targetUrl: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  timeoutMs: number,
  breaker: CircuitBreaker,
  mode: ForwardMode = "raw",
): Promise<void> {
  const requestHeaders = request.headers as Record<string, string | undefined>;

  try {
    if (mode === "json") {
      const result = await breaker.call(() =>
        forwardHttp({ targetUrl, method, requestHeaders, body: request.body, timeoutMs }),
      );
      reply.code(result.status);
      reply.header("content-type", result.contentType);
      reply.send(result.payload);
      return;
    }

    // JSON bodies arrive as Buffers (see registerRawJsonBodyParser); Fastify's built-in text/plain parser yields a string.
    const body =
      Buffer.isBuffer(request.body) ? request.body : typeof request.body === "string" ? Buffer.from(request.body) : undefined;
    const result = await breaker.call(() =>
      forwardHttpRaw({ targetUrl, method, requestHeaders, body, timeoutMs }),
    );

    reply.code(result.status);
    reply.header("content-type", result.contentType);
    // JSON mode answered `{}` for an empty JSON body; keep that for clients.
    const emptyJson =
      result.body.length === 0 && result.contentType.includes("application/json") && !BODYLESS_STATUSES.has(result.status);
    reply.send(emptyJson ? "{}" : result.body);
  } catch (error) {
    if (error instanceof CircuitBreakerOpenError) {
      reply.code(503).send({ error: "Service temporarily unavailable" });
      return;
    }
    throw error;
  }
}

/**
 * Makes `application/json` bodies reach the handlers as the original Buffer so raw routes can forward
 * them untouched. Routes that read `request.body` themselves opt back in to normal JSON parsing with
 * `config: { parseJsonBody: true }` (same parser and error behaviour as Fastify's default).
 */
function registerRawJsonBodyParser(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const config = request.routeOptions?.config as { parseJsonBody?: boolean } | undefined;
    if (config?.parseJsonBody) {
      parseJson(request, (body as Buffer).toString("utf8"), done);
      return;
    }
    done(null, body);
  });
}

/** Registers all gateway proxy routes that forward to downstream BFF services. */
export async function proxyRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const upstreamTimeoutMs = config.UPSTREAM_TIMEOUT_MS ?? 15000;
  const upstreamGenerationTimeoutMs = config.UPSTREAM_GENERATION_TIMEOUT_MS ?? 60000;
  const routingStore = new RoutingStateStore(config);
  await routingStore.load();
  registerRawJsonBodyParser(app);

  app.get("/internal/admin/ai-engine/target", async (request, reply) => {
    if (!isGatewayAdminAuthorized(request, config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    return reply.send(getAiEngineTarget(config, routingStore));
  });

  app.put("/internal/admin/ai-engine/target", { config: { parseJsonBody: true } }, async (request, reply) => {
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

  const baseUrl: Record<Upstream, () => string> = {
    "bff-mobile": () => config.BFF_MOBILE_URL,
    "bff-backoffice": () => config.BFF_BACKOFFICE_URL,
    "ai-engine-api": () => getAiEngineApiBaseUrl(config, routingStore),
    "ai-engine-stats": () => getAiEngineStatsBaseUrl(config, routingStore),
  };
  const timeoutMs: Record<TimeoutKind, number> = {
    default: upstreamTimeoutMs,
    generation: upstreamGenerationTimeoutMs,
  };
  // New auth kinds are added here and in the `Auth` type. Both guards fail closed outside development/test.
  const authGuard: Record<Auth, (request: FastifyRequest, reply: FastifyReply) => boolean> = {
    none: () => true,
    edge: (request, reply) => checkEdgeAuth(request, reply, config),
    internal: (request, reply) => checkInternalAuth(request, reply, config),
  };

  // Plain forwards: one generic handler driven by ROUTE_TABLE.
  for (const route of ROUTE_TABLE) {
    app.route({
      method: route.method,
      url: route.path,
      handler: async (request, reply) => {
        if (!authGuard[route.auth](request, reply)) {
          return;
        }

        const base = baseUrl[route.upstream]();
        const query = applyQueryPolicy(route.query, (request.query as Record<string, unknown>) ?? {});
        const url = buildUrl(base, fillPathParams(route.upstreamPath, request.params), query);
        await forwardRequest(request, reply, url, route.method, timeoutMs[route.timeout], getBreakerForUrl(base));
      },
    });
  }

  // Routes that validate their query stay explicit: the validated (and re-serialized) query is forwarded in "json" mode.
  function registerValidatedGet(
    path: string,
    schema: z.ZodType<Record<string, unknown>>,
    upstream: Upstream,
    auth: Auth,
    query: (data: Record<string, unknown>) => Record<string, unknown>,
  ): void {
    app.get(path, async (request, reply) => {
      if (!authGuard[auth](request, reply)) {
        return;
      }

      const parsedQuery = schema.safeParse(request.query ?? {});
      if (!parsedQuery.success) {
        return sendValidationError(reply, parsedQuery.error);
      }

      const base = baseUrl[upstream]();
      const url = buildUrl(base, path, query(parsedQuery.data));
      await forwardRequest(request, reply, url, "GET", upstreamTimeoutMs, getBreakerForUrl(base), "json");
    });
  }

  registerValidatedGet("/v1/mobile/games/quiz/random", MobileRandomQuerySchema, "bff-mobile", "none", omitLanguageQuery);
  registerValidatedGet("/v1/mobile/games/wordpass/random", MobileRandomQuerySchema, "bff-mobile", "none", omitLanguageQuery);
  registerValidatedGet("/v1/backoffice/users/leaderboard", LeaderboardQuerySchema, "bff-backoffice", "edge", (data) => data);
}
