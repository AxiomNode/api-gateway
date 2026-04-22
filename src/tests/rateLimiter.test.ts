import { describe, expect, it } from "vitest";

import { RateLimiter, classifyRoute } from "../app/services/rateLimiter.js";

const baseConfig = {
  SERVICE_NAME: "api-gateway",
  SERVICE_PORT: 7005,
  NODE_ENV: "test",
  ALLOWED_ORIGINS: "http://localhost:3000",
  BFF_MOBILE_URL: "http://localhost:7010",
  BFF_BACKOFFICE_URL: "http://localhost:7011",
  EDGE_API_TOKEN: "",
};

describe("classifyRoute", () => {
  it("skips health and OPTIONS", () => {
    expect(classifyRoute("GET", "/health")).toBe("skip");
    expect(classifyRoute("GET", "/v1/health")).toBe("skip");
    expect(classifyRoute("OPTIONS", "/v1/mobile/games/quiz/random")).toBe("skip");
  });

  it("classifies generation, auth, admin, default", () => {
    expect(classifyRoute("POST", "/v1/mobile/games/quiz/generate")).toBe("generation");
    expect(classifyRoute("POST", "/internal/ai-engine/ingest/quiz")).toBe("generation");
    expect(classifyRoute("POST", "/v1/backoffice/auth/session")).toBe("auth");
    expect(classifyRoute("PUT", "/internal/admin/ai-engine/target")).toBe("admin");
    expect(classifyRoute("GET", "/v1/mobile/games/quiz/random")).toBe("default");
  });
});

describe("RateLimiter", () => {
  it("allows up to the configured maximum and blocks afterward", () => {
    const limiter = new RateLimiter({
      ...baseConfig,
      RATE_LIMIT_ENABLED: true,
      RATE_LIMIT_DEFAULT_MAX: 3,
      RATE_LIMIT_WINDOW_MS: 60_000,
    });

    const decisions = Array.from({ length: 4 }, () => limiter.consume("1.2.3.4", "default", 1_000));
    expect(decisions.slice(0, 3).every((d) => d.allowed)).toBe(true);
    expect(decisions[3].allowed).toBe(false);
    expect(decisions[3].retryAfterSeconds).toBeGreaterThan(0);
    expect(decisions[3].limit).toBe(3);
  });

  it("resets after the window elapses", () => {
    const limiter = new RateLimiter({
      ...baseConfig,
      RATE_LIMIT_ENABLED: true,
      RATE_LIMIT_DEFAULT_MAX: 1,
      RATE_LIMIT_WINDOW_MS: 1_000,
    });

    expect(limiter.consume("ip", "default", 0).allowed).toBe(true);
    expect(limiter.consume("ip", "default", 100).allowed).toBe(false);
    expect(limiter.consume("ip", "default", 1_500).allowed).toBe(true);
  });

  it("isolates limits per category", () => {
    const limiter = new RateLimiter({
      ...baseConfig,
      RATE_LIMIT_ENABLED: true,
      RATE_LIMIT_DEFAULT_MAX: 1,
      RATE_LIMIT_GENERATION_MAX: 2,
      RATE_LIMIT_WINDOW_MS: 60_000,
    });

    expect(limiter.consume("ip", "default", 0).allowed).toBe(true);
    expect(limiter.consume("ip", "default", 0).allowed).toBe(false);
    expect(limiter.consume("ip", "generation", 0).allowed).toBe(true);
    expect(limiter.consume("ip", "generation", 0).allowed).toBe(true);
    expect(limiter.consume("ip", "generation", 0).allowed).toBe(false);
  });

  it("returns allowed when disabled", () => {
    const limiter = new RateLimiter({
      ...baseConfig,
      RATE_LIMIT_ENABLED: false,
      RATE_LIMIT_DEFAULT_MAX: 1,
      RATE_LIMIT_WINDOW_MS: 60_000,
    });

    for (let i = 0; i < 10; i += 1) {
      expect(limiter.consume("ip", "default", 0).allowed).toBe(true);
    }
  });
});
