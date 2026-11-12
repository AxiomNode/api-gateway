import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify from "fastify";

import { loadConfig } from "../app/config.js";
import { proxyRoutes } from "../app/routes/proxy.js";
import { buildServer } from "../app/server.js";

let dir = "";

const base = {
  SERVICE_NAME: "api-gateway",
  SERVICE_PORT: 7005,
  ALLOWED_ORIGINS: "http://localhost:3000",
  BFF_MOBILE_URL: "http://bff-mobile:7010",
  BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
  AI_ENGINE_API_URL: "http://ai-api:7001",
  AI_ENGINE_STATS_URL: "http://ai-stats:7000",
};

function okFetch() {
  const fetchMock = vi.fn().mockImplementation(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "axiomnode-gateway-auth-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("loadConfig fail-closed", () => {
  it("refuses to load in production without tokens", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EDGE_API_TOKEN", "");
    vi.stubEnv("API_GATEWAY_ADMIN_TOKEN", "");
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "");
    expect(() => loadConfig()).toThrow(/Refusing to start.*EDGE_API_TOKEN.*API_GATEWAY_ADMIN_TOKEN.*INTERNAL_SERVICE_TOKEN/);
  });

  it("loads in production when every token is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EDGE_API_TOKEN", "e");
    vi.stubEnv("API_GATEWAY_ADMIN_TOKEN", "a");
    vi.stubEnv("INTERNAL_SERVICE_TOKEN", "i");
    expect(loadConfig().INTERNAL_SERVICE_TOKEN).toBe("i");
  });

  it("loads in development without tokens", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => loadConfig()).not.toThrow();
  });

  it("rejects an invalid TRUST_PROXY value", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("TRUST_PROXY", "maybe");
    expect(() => loadConfig()).toThrow(/Invalid gateway configuration/);
  });
});

describe("proxy auth fail-closed", () => {
  it("rejects edge routes with 503 outside development/test when EDGE_API_TOKEN is empty", async () => {
    const fetchMock = okFetch();
    const app = Fastify();
    await proxyRoutes(app, { ...base, NODE_ENV: "production", EDGE_API_TOKEN: "", GATEWAY_ROUTING_STATE_FILE: path.join(dir, "s.json") });

    const response = await app.inject({ method: "POST", url: "/v1/backoffice/auth/session", payload: {} });
    expect(response.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects admin routes outside development/test when the admin token is empty", async () => {
    okFetch();
    const app = Fastify();
    await proxyRoutes(app, { ...base, NODE_ENV: "production", EDGE_API_TOKEN: "e", GATEWAY_ROUTING_STATE_FILE: path.join(dir, "s.json") });

    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: "/internal/admin/ai-engine/target",
        payload: method === "PUT" ? { host: "localhost" } : undefined,
      });
      expect(response.statusCode).toBe(401);
    }
    const bogus = await app.inject({ method: "GET", url: "/internal/admin/ai-engine/target", headers: { authorization: "Bearer " } });
    expect(bogus.statusCode).toBe(401);
    await app.close();
  });

  it("keeps admin routes open in development when the admin token is empty", async () => {
    okFetch();
    const app = Fastify();
    await proxyRoutes(app, { ...base, NODE_ENV: "development", EDGE_API_TOKEN: "", GATEWAY_ROUTING_STATE_FILE: path.join(dir, "s.json") });
    const response = await app.inject({ method: "GET", url: "/internal/admin/ai-engine/target" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("requires x-internal-token on every /internal/ai-engine route", async () => {
    const fetchMock = okFetch();
    const app = Fastify();
    await proxyRoutes(app, {
      ...base,
      NODE_ENV: "production",
      EDGE_API_TOKEN: "e",
      API_GATEWAY_ADMIN_TOKEN: "a",
      INTERNAL_SERVICE_TOKEN: "svc-token",
      GATEWAY_ROUTING_STATE_FILE: path.join(dir, "s.json"),
    });

    const routes: Array<["GET" | "POST", string]> = [
      ["POST", "/internal/ai-engine/generate/quiz"],
      ["POST", "/internal/ai-engine/generate/word-pass"],
      ["POST", "/internal/ai-engine/ingest/quiz"],
      ["POST", "/internal/ai-engine/ingest/word-pass"],
      ["GET", "/internal/ai-engine/catalogs"],
      ["GET", "/internal/ai-engine/health"],
      ["GET", "/internal/ai-engine/stats"],
    ];
    const call = (method: "GET" | "POST", url: string, headers: Record<string, string>) =>
      app.inject({ method, url, headers, payload: method === "POST" ? {} : undefined });

    for (const [method, url] of routes) {
      const missing = await call(method, url, {});
      const wrong = await call(method, url, { "x-internal-token": "nope" });
      const edgeTokenDoesNotHelp = await call(method, url, { authorization: "Bearer e" });
      expect([missing.statusCode, wrong.statusCode, edgeTokenDoesNotHelp.statusCode]).toEqual([401, 401, 401]);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    for (const [method, url] of routes) {
      const ok = await call(method, url, { "x-internal-token": "svc-token" });
      expect(ok.statusCode).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(routes.length);
    await app.close();
  });

  it("returns 503 on internal routes outside development/test when the service token is unset", async () => {
    const fetchMock = okFetch();
    const app = Fastify();
    await proxyRoutes(app, { ...base, NODE_ENV: "production", EDGE_API_TOKEN: "e", GATEWAY_ROUTING_STATE_FILE: path.join(dir, "s.json") });
    const response = await app.inject({ method: "GET", url: "/internal/ai-engine/health", headers: { "x-internal-token": "anything" } });
    expect(response.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("stays permissive on internal routes in test mode when the service token is unset", async () => {
    okFetch();
    const app = Fastify();
    await proxyRoutes(app, { ...base, NODE_ENV: "test", EDGE_API_TOKEN: "", GATEWAY_ROUTING_STATE_FILE: path.join(dir, "s.json") });
    const response = await app.inject({ method: "GET", url: "/internal/ai-engine/health" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe("routing target allowlist", () => {
  function config(extra: { NODE_ENV: string; ALLOWED_ROUTING_TARGET_HOSTS?: string }) {
    return {
      ...base,
      EDGE_API_TOKEN: "e",
      API_GATEWAY_ADMIN_TOKEN: "a",
      INTERNAL_SERVICE_TOKEN: "i",
      GATEWAY_ROUTING_STATE_FILE: path.join(dir, "s.json"),
      ...extra,
    };
  }
  const put = (app: ReturnType<typeof Fastify>, payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: "/internal/admin/ai-engine/target", headers: { authorization: "Bearer a" }, payload });

  it("accepts allowlisted hostnames and CIDR members and rejects others", async () => {
    const app = Fastify();
    await proxyRoutes(app, config({ NODE_ENV: "production", ALLOWED_ROUTING_TARGET_HOSTS: "gpu.internal,10.0.0.0/8" }));

    expect((await put(app, { host: "gpu.internal" })).statusCode).toBe(200);
    expect((await put(app, { host: "10.1.2.3", protocol: "https" })).statusCode).toBe(200);
    expect((await put(app, { host: "169.254.169.254" })).statusCode).toBe(400);
    expect((await put(app, { host: "evil.example.net" })).statusCode).toBe(400);
    await app.close();
  });

  it("denies every override in production when the allowlist is empty", async () => {
    const app = Fastify();
    await proxyRoutes(app, config({ NODE_ENV: "production" }));
    expect((await put(app, { host: "localhost" })).statusCode).toBe(400);
    await app.close();
  });

  it("allows any host in development with an empty allowlist", async () => {
    const app = Fastify();
    await proxyRoutes(app, config({ NODE_ENV: "development" }));
    expect((await put(app, { host: "anywhere.dev" })).statusCode).toBe(200);
    await app.close();
  });

  it("rejects non-http(s) schemes and malformed hosts", async () => {
    const app = Fastify();
    await proxyRoutes(app, config({ NODE_ENV: "development" }));
    expect((await put(app, { host: "localhost", protocol: "file" })).statusCode).toBe(400);
    expect((await put(app, { host: "bad host!", protocol: "http" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("trust proxy wiring", () => {
  async function build(trustProxy: string | undefined) {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RATE_LIMIT_ENABLED", "true");
    vi.stubEnv("RATE_LIMIT_DEFAULT_MAX", "1");
    vi.stubEnv("GATEWAY_ROUTING_STATE_FILE", path.join(dir, "s.json"));
    if (trustProxy !== undefined) {
      vi.stubEnv("TRUST_PROXY", trustProxy);
    }
    okFetch();
    return buildServer();
  }

  const hit = (app: Awaited<ReturnType<typeof buildServer>>["app"], forwarded: string) =>
    app.inject({
      method: "GET",
      url: "/v1/mobile/games/quiz/random",
      remoteAddress: "10.0.0.5",
      headers: { "x-forwarded-for": forwarded },
    });

  it("ignores X-Forwarded-For by default so clients share the proxy bucket", async () => {
    const { app } = await build(undefined);
    expect((await hit(app, "203.0.113.1")).statusCode).toBe(200);
    expect((await hit(app, "203.0.113.2")).statusCode).toBe(429);
    await app.close();
  });

  it("keys the limiter on the forwarded client IP when TRUST_PROXY=true", async () => {
    const { app } = await build("true");
    expect((await hit(app, "203.0.113.1")).statusCode).toBe(200);
    expect((await hit(app, "203.0.113.2")).statusCode).toBe(200);
    expect((await hit(app, "203.0.113.1")).statusCode).toBe(429);
    await app.close();
  });

  it("supports hop counts and CIDR lists", async () => {
    for (const value of ["1", "10.0.0.0/8"]) {
      const { app } = await build(value);
      expect((await hit(app, "203.0.113.1")).statusCode).toBe(200);
      expect((await hit(app, "203.0.113.2")).statusCode).toBe(200);
      expect((await hit(app, "203.0.113.1")).statusCode).toBe(429);
      await app.close();
      vi.unstubAllEnvs();
    }
  });

  it("does not trust forwarded headers from peers outside the CIDR list", async () => {
    const { app } = await build("192.168.0.0/16");
    expect((await hit(app, "203.0.113.1")).statusCode).toBe(200);
    expect((await hit(app, "203.0.113.2")).statusCode).toBe(429);
    await app.close();
  });
});
