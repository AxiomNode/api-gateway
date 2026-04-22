import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../app/server.js";

let stateDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "axiomnode-gateway-rl-"));
  vi.stubEnv("SERVICE_NAME", "api-gateway");
  vi.stubEnv("SERVICE_PORT", "7005");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("ALLOWED_ORIGINS", "http://localhost:3000");
  vi.stubEnv("BFF_MOBILE_URL", "http://bff-mobile:7010");
  vi.stubEnv("BFF_BACKOFFICE_URL", "http://bff-backoffice:7011");
  vi.stubEnv("AI_ENGINE_API_URL", "http://ai-api:7001");
  vi.stubEnv("AI_ENGINE_STATS_URL", "http://ai-stats:7000");
  vi.stubEnv("EDGE_API_TOKEN", "");
  vi.stubEnv("GATEWAY_ROUTING_STATE_FILE", path.join(stateDir, "routing-state.json"));
  vi.stubEnv("RATE_LIMIT_ENABLED", "true");
  vi.stubEnv("RATE_LIMIT_DEFAULT_MAX", "2");
  vi.stubEnv("RATE_LIMIT_GENERATION_MAX", "1");
  vi.stubEnv("RATE_LIMIT_AUTH_MAX", "10");
  vi.stubEnv("RATE_LIMIT_ADMIN_MAX", "10");
  vi.stubEnv("RATE_LIMIT_WINDOW_MS", "60000");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
    stateDir = "";
  }
});

describe("server rate limiting", () => {
  it("returns 429 when default IP limit is exceeded and exposes Prometheus counters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { app, metrics } = await buildServer();

    const url = "/v1/mobile/games/quiz/random?language=es";
    const allowed1 = await app.inject({ method: "GET", url });
    const allowed2 = await app.inject({ method: "GET", url });
    const blocked = await app.inject({ method: "GET", url });

    expect(allowed1.statusCode).toBe(200);
    expect(allowed2.statusCode).toBe(200);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(blocked.json()).toMatchObject({
      message: "Too Many Requests",
      category: "default",
    });

    const prom = metrics.toPrometheus();
    expect(prom).toContain("gateway_rate_limit_blocks_total");
    expect(prom).toContain('gateway_rate_limit_blocks_by_category_total{service="api-gateway",category="default"} 1');

    await app.close();
  });

  it("applies a stricter limit to generation routes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { app, metrics } = await buildServer();

    const url = "/v1/mobile/games/quiz/generate";
    const allowed = await app.inject({ method: "POST", url, payload: {} });
    const blocked = await app.inject({ method: "POST", url, payload: {} });

    expect(allowed.statusCode).toBe(200);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ category: "generation" });

    const prom = metrics.toPrometheus();
    expect(prom).toContain('gateway_rate_limit_blocks_by_category_total{service="api-gateway",category="generation"} 1');

    await app.close();
  });

  it("does not rate-limit health checks", async () => {
    const { app } = await buildServer();
    for (let i = 0; i < 10; i += 1) {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
    }
    await app.close();
  });
});
