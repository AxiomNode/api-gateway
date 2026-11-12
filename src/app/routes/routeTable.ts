/** @module routeTable — Declarative table of the gateway routes that are plain forwards to an upstream. */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Where a route is forwarded. The ai-engine bases are resolved per request (runtime override). */
export type Upstream = "bff-mobile" | "bff-backoffice" | "ai-engine-api" | "ai-engine-stats";

/**
 * Auth rule enforced by the gateway before forwarding: `edge` is the bearer token (EDGE_API_TOKEN),
 * `internal` the service-to-service `x-internal-token` header (INTERNAL_SERVICE_TOKEN).
 */
export type Auth = "none" | "edge" | "internal";

/**
 * What happens to the incoming query string:
 * - "drop": nothing is forwarded (the default; the upstream path is fixed).
 * - "forward": forwarded as received.
 * - "forward-without-language": forwarded without the legacy `language` parameter.
 */
export type QueryPolicy = "drop" | "forward" | "forward-without-language";

/** Which upstream timeout applies: the regular one or the (longer) generation one. */
export type TimeoutKind = "default" | "generation";

export interface RouteDef {
  method: HttpMethod;
  /** Public path as exposed by the gateway; `:name` segments are path parameters. */
  path: string;
  /** Path requested from the upstream; equals `path` unless the section strips a prefix. */
  upstreamPath: string;
  upstream: Upstream;
  auth: Auth;
  query: QueryPolicy;
  timeout: TimeoutKind;
}

type Entry = readonly [method: HttpMethod, path: string, options?: { query?: QueryPolicy; timeout?: TimeoutKind }];

interface Section {
  upstream: Upstream;
  auth: Auth;
  /** Prepended to every entry path to build the public path. */
  prefix?: string;
  /** Public prefix replaced by `upstreamPrefix` when building the upstream path. */
  rewrite?: { from: string; to: string };
}

function section(defaults: Section, entries: readonly Entry[]): RouteDef[] {
  return entries.map(([method, relativePath, options]) => {
    const path = `${defaults.prefix ?? ""}${relativePath}`;
    const upstreamPath = defaults.rewrite ? path.replace(defaults.rewrite.from, defaults.rewrite.to) : path;
    return {
      method,
      path,
      upstreamPath,
      upstream: defaults.upstream,
      auth: defaults.auth,
      query: options?.query ?? "drop",
      timeout: options?.timeout ?? "default",
    };
  });
}

/**
 * Plain-forward routes. Routes that validate input (`GET /v1/mobile/games/{quiz,wordpass}/random`,
 * `GET /v1/backoffice/users/leaderboard`) and the `/internal/admin/*` routes are explicit handlers in proxy.ts.
 */
export const ROUTE_TABLE: readonly RouteDef[] = [
  ...section({ upstream: "bff-mobile", auth: "none" }, [
    ["GET", "/v1/mobile/games/categories"],
    ["GET", "/v1/mobile/player/profile"],
    ["PUT", "/v1/mobile/player/profile"],
    ["POST", "/v1/mobile/games/events"],
    ["POST", "/v1/mobile/games/quiz/generate", { timeout: "generation" }],
    ["POST", "/v1/mobile/games/wordpass/generate", { timeout: "generation" }],
  ]),

  ...section({ upstream: "bff-backoffice", auth: "edge", prefix: "/v1/backoffice" }, [
    ["POST", "/auth/session"],
    ["GET", "/auth/me"],
    ["GET", "/monitor/stats", { query: "forward" }],
    ["POST", "/users/events/manual"],
    ["GET", "/admin/users/roles"],
    ["PATCH", "/admin/users/roles/:firebaseUid"],
    ["GET", "/services"],
    ["GET", "/services/operational-summary"],
    ["GET", "/kubernetes/overview"],
    ["GET", "/ai-engine/target"],
    ["GET", "/ai-engine/plugin/capabilities"],
    ["PUT", "/ai-engine/target"],
    ["DELETE", "/ai-engine/target"],
    ["GET", "/ai-engine/presets"],
    ["POST", "/ai-engine/presets"],
    ["PUT", "/ai-engine/presets/:presetId"],
    ["DELETE", "/ai-engine/presets/:presetId"],
    ["POST", "/ai-engine/probe"],
    ["GET", "/ai-engine/connections"],
    ["POST", "/ai-engine/connections"],
    ["PUT", "/ai-engine/connections/:presetId"],
    ["DELETE", "/ai-engine/connections/:presetId"],
    ["POST", "/ai-engine/connections/:presetId/activate"],
    ["GET", "/ai-diagnostics/rag/stats"],
    ["POST", "/ai-diagnostics/tests/run"],
    ["GET", "/ai-diagnostics/tests/status"],
    ["GET", "/service-targets"],
    ["PUT", "/service-targets/:service"],
    ["DELETE", "/service-targets/:service"],
    ["GET", "/services/:service/metrics", { query: "forward" }],
    ["GET", "/services/:service/logs", { query: "forward" }],
    ["GET", "/services/:service/data", { query: "forward" }],
    ["GET", "/services/:service/catalogs"],
    ["POST", "/services/:service/data"],
    ["PATCH", "/services/:service/data/:entryId"],
    ["DELETE", "/services/:service/data/:entryId", { query: "forward" }],
    ["POST", "/services/:service/generation/process"],
    ["POST", "/services/:service/generation/wait"],
    ["GET", "/services/:service/generation/processes", { query: "forward" }],
    ["GET", "/services/:service/generation/process/:taskId", { query: "forward" }],
    ["GET", "/services/:service/generation/worker"],
    ["POST", "/services/:service/generation/worker/start"],
    ["POST", "/services/:service/generation/worker/stop"],
  ]),

  // ai-engine proxy: /internal/ai-engine/<x> -> <ai-engine base>/<x>, service-to-service (x-internal-token).
  ...section(
    { upstream: "ai-engine-api", auth: "internal", prefix: "/internal/ai-engine", rewrite: { from: "/internal/ai-engine", to: "" } },
    [
      ["POST", "/generate/quiz", { query: "forward-without-language", timeout: "generation" }],
      ["POST", "/generate/word-pass", { query: "forward-without-language", timeout: "generation" }],
      ["POST", "/ingest/quiz", { timeout: "generation" }],
      ["POST", "/ingest/word-pass", { timeout: "generation" }],
      ["GET", "/catalogs"],
      ["GET", "/health"],
    ],
  ),
  ...section(
    { upstream: "ai-engine-stats", auth: "internal", prefix: "/internal/ai-engine", rewrite: { from: "/internal/ai-engine", to: "" } },
    [["GET", "/stats", { query: "forward" }]],
  ),
];
