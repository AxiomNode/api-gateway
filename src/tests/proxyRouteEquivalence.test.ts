import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";

import { proxyRoutes } from "../app/routes/proxy.js";

/**
 * Route-equivalence contract for the gateway proxy.
 *
 * `fixtures/gatewayRoutes.json` was extracted mechanically from the hand-written `proxy.ts` on
 * `main` (62 route registrations, including the fail-closed edge auth and the `/internal/*` token
 * rules). This suite asserts that the implementation exposes exactly
 * that route set and maps every entry to the same upstream, URL, query handling, timeout, forward
 * mode and auth rule. It must keep passing, unchanged, across any refactor of how routes are declared.
 */

type FixtureRoute = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  kind: "table" | "explicit-validated" | "explicit-admin";
  auth?: "none" | "edge" | "internal";
  upstream?: "bff-mobile" | "bff-backoffice" | "ai-engine-api" | "ai-engine-stats";
  upstreamPath?: string;
  query?: "drop" | "forward" | "forward-without-language" | "validated" | "validated-without-language";
  timeout?: "default" | "generation";
  mode?: "raw" | "json";
};

const forwardRaw = vi.fn();
const forwardJson = vi.fn();

vi.mock("@axiomnode/shared-sdk-client/proxy-raw", () => ({
  forwardHttpRaw: (params: unknown) => forwardRaw(params),
}));

vi.mock("@axiomnode/shared-sdk-client/proxy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@axiomnode/shared-sdk-client/proxy")>();
  return { ...actual, forwardHttp: (params: unknown) => forwardJson(params) };
});

const fixture: FixtureRoute[] = JSON.parse(
  await readFile(new URL("./fixtures/gatewayRoutes.json", import.meta.url), "utf8"),
);

const BASES = {
  "bff-mobile": "http://bff-mobile:7010",
  "bff-backoffice": "http://bff-backoffice:7011",
  "ai-engine-api": "http://ai-api:7001",
  "ai-engine-stats": "http://ai-stats:7000",
} as const;
const EDGE_TOKEN = "edge-secret";
const INTERNAL_TOKEN = "internal-secret";
const ADMIN_TOKEN = "admin-secret";
const TIMEOUTS = { default: 11_111, generation: 22_222 } as const;
// "a%2Fb" exercises path-parameter re-encoding (Fastify decodes it, the gateway must encode it again).
const PARAM_VALUE = "a%2Fb";
const ENCODED_PARAM = "a%2Fb";

let tempDir = "";
let app: FastifyInstance;
const registered: Array<{ method: string; url: string }> = [];

function config(overrides: Record<string, unknown> = {}) {
  return {
    SERVICE_NAME: "api-gateway",
    SERVICE_PORT: 7005,
    NODE_ENV: "test",
    ALLOWED_ORIGINS: "http://localhost:3000",
    BFF_MOBILE_URL: BASES["bff-mobile"],
    BFF_BACKOFFICE_URL: BASES["bff-backoffice"],
    AI_ENGINE_API_URL: BASES["ai-engine-api"],
    AI_ENGINE_STATS_URL: BASES["ai-engine-stats"],
    EDGE_API_TOKEN: EDGE_TOKEN,
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
    UPSTREAM_TIMEOUT_MS: TIMEOUTS.default,
    UPSTREAM_GENERATION_TIMEOUT_MS: TIMEOUTS.generation,
    GATEWAY_ROUTING_STATE_FILE: path.join(tempDir, "routing-state.json"),
    ...overrides,
  } as never;
}

function concretePath(template: string): string {
  return template.replace(/:\w+/g, PARAM_VALUE);
}

function expectedUpstreamPath(route: FixtureRoute): string {
  return route.upstreamPath!.replace(/:\w+/g, ENCODED_PARAM);
}

async function build(overrides: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const instance = Fastify();
  await proxyRoutes(instance, config(overrides));
  return instance;
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "axiomnode-gateway-equiv-"));
  forwardRaw.mockReset().mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from("{}") });
  forwardJson.mockReset().mockResolvedValue({ status: 200, contentType: "application/json", payload: {} });
  registered.length = 0;
  app = Fastify();
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      if (method !== "HEAD") {
        registered.push({ method, url: route.url });
      }
    }
  });
  await proxyRoutes(app, config());
});

afterEach(async () => {
  await app.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("gateway route equivalence", () => {
  it("fixture covers the 62 original registrations", () => {
    expect(fixture).toHaveLength(62);
    expect(fixture.filter((route) => route.kind === "explicit-admin")).toHaveLength(3);
    expect(fixture.filter((route) => route.kind === "explicit-validated")).toHaveLength(3);
  });

  it("pins how many routes carry each auth rule, so no route can silently lose its auth", () => {
    const count = (auth: string) => fixture.filter((route) => route.auth === auth).length;
    expect(count("edge")).toBe(44);
    expect(count("internal")).toBe(7);
    expect(count("none")).toBe(8);
    const internal = fixture.filter((route) => route.path.startsWith("/internal/ai-engine/"));
    expect(internal).toHaveLength(7);
    expect(internal.every((route) => route.auth === "internal")).toBe(true);
    const backoffice = fixture.filter((route) => route.path.startsWith("/v1/backoffice/"));
    expect(backoffice).toHaveLength(44);
    expect(backoffice.every((route) => route.auth === "edge")).toBe(true);
  });

  it("registers exactly the fixture routes (no more, no fewer)", () => {
    const actual = registered.map((route) => `${route.method} ${route.url}`).sort();
    const expected = fixture.map((route) => `${route.method} ${route.path}`).sort();
    expect(actual).toEqual(expected);
  });

  const forwarded = fixture.filter((route) => route.kind !== "explicit-admin");

  describe.each(forwarded.map((route) => [`${route.method} ${route.path}`, route] as const))("%s", (_name, route) => {
    const url = concretePath(route.path);
    const sentMock = () => (route.mode === "json" ? forwardJson : forwardRaw);
    const otherMock = () => (route.mode === "json" ? forwardRaw : forwardJson);

    if (route.auth === "edge") {
      it("rejects a missing or wrong bearer token with 401 and never forwards", async () => {
        const missing = await app.inject({ method: route.method, url });
        const wrong = await app.inject({
          method: route.method,
          url,
          headers: { authorization: "Bearer nope" },
        });
        // The service token does not open edge routes.
        const internalOnly = await app.inject({
          method: route.method,
          url,
          headers: { "x-internal-token": INTERNAL_TOKEN },
        });
        expect(missing.statusCode).toBe(401);
        expect(wrong.statusCode).toBe(401);
        expect(internalOnly.statusCode).toBe(401);
        expect(forwardRaw).not.toHaveBeenCalled();
        expect(forwardJson).not.toHaveBeenCalled();
      });

      it("fails closed with 503 when no edge token is configured outside development/test", async () => {
        const closed = await build({ NODE_ENV: "production", EDGE_API_TOKEN: "" });
        const response = await closed.inject({ method: route.method, url });
        expect(response.statusCode).toBe(503);
        expect(forwardRaw).not.toHaveBeenCalled();
        expect(forwardJson).not.toHaveBeenCalled();
        await closed.close();
      });
    } else if (route.auth === "internal") {
      it("rejects a missing or wrong x-internal-token with 401 and never forwards", async () => {
        const missing = await app.inject({ method: route.method, url });
        const wrong = await app.inject({
          method: route.method,
          url,
          headers: { "x-internal-token": "nope" },
        });
        // The edge bearer token does not open internal routes.
        const edgeOnly = await app.inject({
          method: route.method,
          url,
          headers: { authorization: `Bearer ${EDGE_TOKEN}` },
        });
        expect(missing.statusCode).toBe(401);
        expect(wrong.statusCode).toBe(401);
        expect(edgeOnly.statusCode).toBe(401);
        expect(forwardRaw).not.toHaveBeenCalled();
        expect(forwardJson).not.toHaveBeenCalled();
      });

      it("fails closed with 503 when no internal token is configured outside development/test", async () => {
        const closed = await build({ NODE_ENV: "production", INTERNAL_SERVICE_TOKEN: "" });
        const response = await closed.inject({
          method: route.method,
          url,
          headers: { "x-internal-token": INTERNAL_TOKEN },
        });
        expect(response.statusCode).toBe(503);
        expect(forwardRaw).not.toHaveBeenCalled();
        expect(forwardJson).not.toHaveBeenCalled();
        await closed.close();
      });
    } else {
      it("is reachable without credentials, even when no token is configured in production", async () => {
        const response = await app.inject({ method: route.method, url });
        expect(response.statusCode).not.toBe(401);
        expect(sentMock()).toHaveBeenCalledTimes(1);

        const closed = await build({ NODE_ENV: "production", EDGE_API_TOKEN: "", INTERNAL_SERVICE_TOKEN: "" });
        const open = await closed.inject({ method: route.method, url });
        expect(open.statusCode).toBe(200);
        expect(sentMock()).toHaveBeenCalledTimes(2);
        await closed.close();
      });
    }

    if (route.kind === "explicit-validated") {
      it("rejects an unknown query parameter with the 400 validation envelope", async () => {
        const response = await app.inject({
          method: route.method,
          url: `${url}?bogus=1`,
          headers: { authorization: `Bearer ${EDGE_TOKEN}` },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ message: "Invalid query parameters" });
        expect(forwardJson).not.toHaveBeenCalled();
      });
    }

    it("forwards to the same upstream URL, method, timeout and mode", async () => {
      const queryString =
        route.kind === "explicit-validated"
          ? route.path.includes("leaderboard")
            ? "?metric=won&limit=5"
            : "?language=es&count=3"
          : "?language=es&foo=1&bar=two";
      const response = await app.inject({
        method: route.method,
        url: `${url}${queryString}`,
        headers: { authorization: `Bearer ${EDGE_TOKEN}`, "x-internal-token": INTERNAL_TOKEN, "x-correlation-id": "corr-1" },
      });

      expect(response.statusCode).toBe(200);
      expect(sentMock()).toHaveBeenCalledTimes(1);
      expect(otherMock()).not.toHaveBeenCalled();

      const params = sentMock().mock.calls[0]![0] as { targetUrl: string; method: string; timeoutMs: number };
      const base = BASES[route.upstream!];
      const expectedQuery = {
        drop: "",
        forward: "?language=es&foo=1&bar=two",
        "forward-without-language": "?foo=1&bar=two",
        validated: "?metric=won&limit=5",
        "validated-without-language": "?count=3",
      }[route.query!];

      expect(params.targetUrl).toBe(`${base}${expectedUpstreamPath(route)}${expectedQuery}`);
      expect(params.method).toBe(route.method);
      expect(params.timeoutMs).toBe(TIMEOUTS[route.timeout!]);
    });
  });

  it("routes ai-engine traffic to the base URL from the runtime override when one is set", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/internal/admin/ai-engine/target",
      payload: { host: "localhost", apiPort: 9101, statsPort: 9100 },
    });
    expect(put.statusCode).toBe(200);

    const headers = { "x-internal-token": INTERNAL_TOKEN };
    await app.inject({ method: "GET", url: "/internal/ai-engine/health", headers });
    await app.inject({ method: "GET", url: "/internal/ai-engine/stats?x=1", headers });
    const targets = forwardRaw.mock.calls.map((call) => (call[0] as { targetUrl: string }).targetUrl);
    expect(targets).toEqual(["http://localhost:9101/health", "http://localhost:9100/stats?x=1"]);
  });

  it("keeps the explicit admin routes behind the admin token rules", async () => {
    const guarded = await build({ API_GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN });
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const denied = await guarded.inject({ method, url: "/internal/admin/ai-engine/target", payload: {} });
      expect(denied.statusCode).toBe(401);
    }
    const allowed = await guarded.inject({
      method: "GET",
      url: "/internal/admin/ai-engine/target",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(allowed.statusCode).toBe(200);
    await guarded.close();
  });

  it("denies the admin routes outside development/test when no admin token is configured", async () => {
    const closed = await build({ NODE_ENV: "production", API_GATEWAY_ADMIN_TOKEN: "" });
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const denied = await closed.inject({ method, url: "/internal/admin/ai-engine/target", payload: {} });
      expect(denied.statusCode).toBe(401);
    }
    await closed.close();
  });

  it("applies the routing allowlist to the admin target route", async () => {
    const restricted = await build({ ALLOWED_ROUTING_TARGET_HOSTS: "ai.internal" });
    const refused = await restricted.inject({
      method: "PUT",
      url: "/internal/admin/ai-engine/target",
      payload: { host: "evil.example" },
    });
    expect(refused.statusCode).toBe(400);
    const accepted = await restricted.inject({
      method: "PUT",
      url: "/internal/admin/ai-engine/target",
      payload: { host: "ai.internal" },
    });
    expect(accepted.statusCode).toBe(200);
    await restricted.close();
  });

  it.each([
    ["GET", "/"],
    ["GET", "/v1/mobile"],
    ["GET", "/v1/mobile/unknown"],
    ["GET", "/v1/mobile/games/categories/extra"],
    ["GET", "/v1/mobile/games/categories/"],
    ["POST", "/v1/mobile/games/categories"],
    ["DELETE", "/v1/mobile/player/profile"],
    ["GET", "/v1/backoffice"],
    ["GET", "/v1/backoffice/unknown"],
    ["DELETE", "/v1/backoffice/services"],
    ["GET", "/v1/backoffice/services/x/unknown"],
    ["GET", "/v1/backoffice/services/x/generation/worker/start"],
    ["GET", "/internal/ai-engine"],
    ["GET", "/internal/ai-engine/unknown"],
    ["POST", "/internal/ai-engine/health"],
    ["GET", "/internal/admin/unknown"],
  ] as const)("keeps unknown or wrong-method path %s %s a 404", async (method, url) => {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${EDGE_TOKEN}`, "x-internal-token": INTERNAL_TOKEN },
    });
    expect(response.statusCode).toBe(404);
    expect(forwardRaw).not.toHaveBeenCalled();
    expect(forwardJson).not.toHaveBeenCalled();
  });
});
