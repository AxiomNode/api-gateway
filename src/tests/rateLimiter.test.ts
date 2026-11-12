import { describe, expect, it, vi } from "vitest";

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

describe("RateLimiter defaults and eviction", () => {
  it("falls back to built-in limits when the optional settings are absent", () => {
    const limiter = new RateLimiter({ ...baseConfig } as never);
    expect(limiter.isEnabled()).toBe(true);
    expect(limiter.limitFor("default").max).toBe(120);
    expect(limiter.limitFor("generation").max).toBe(10);
    expect(limiter.limitFor("auth").max).toBe(30);
    expect(limiter.limitFor("admin").max).toBe(30);
    expect(limiter.limitFor("default").windowMs).toBe(60_000);
  });

  it("evicts expired buckets once the tracked-key cap is exceeded", () => {
    const limiter = new RateLimiter({ ...baseConfig, RATE_LIMIT_MAX_TRACKED_KEYS: 2 } as never);
    limiter.consume("a", "default", 0);
    limiter.consume("b", "default", 0);
    limiter.consume("c", "default", 120_000);
    expect(limiter.size()).toBe(1);
  });

  it("does not track buckets when disabled", () => {
    const limiter = new RateLimiter({ ...baseConfig, RATE_LIMIT_ENABLED: false } as never);
    expect(limiter.consume("a", "default").allowed).toBe(true);
    expect(limiter.size()).toBe(0);
  });
});

describe("RateLimiter bounded eviction", () => {
  const limiterWith = (maxKeys: number, windowMs = 1_000) =>
    new RateLimiter({ ...baseConfig, RATE_LIMIT_ENABLED: true, RATE_LIMIT_MAX_TRACKED_KEYS: maxKeys, RATE_LIMIT_WINDOW_MS: windowMs } as never);

  it("caps the map when every key is fresh (IP spray)", () => {
    const limiter = limiterWith(100);

    for (let i = 0; i < 1_000; i += 1) {
      limiter.consume(`10.0.${Math.floor(i / 250)}.${i % 250}`, "default", 5_000);
    }

    expect(limiter.size()).toBeLessThanOrEqual(100);
  });

  it("sweeps expired buckets at most once per window", () => {
    const limiter = limiterWith(3, 1_000);
    const spy = vi.spyOn(Map.prototype, "entries");

    for (let i = 0; i < 50; i += 1) {
      limiter.consume(`ip-${i}`, "default", 10_000 + i);
    }
    const sweeps = spy.mock.calls.length;
    spy.mockRestore();

    expect(limiter.size()).toBeLessThanOrEqual(3);
    expect(sweeps).toBeLessThanOrEqual(1);
  });

  it("still removes expired buckets once the window has passed", () => {
    const limiter = limiterWith(2, 1_000);
    limiter.consume("a", "default", 10_000);
    limiter.consume("b", "default", 10_000);
    limiter.consume("c", "default", 12_000);

    expect(limiter.size()).toBe(1);
  });

  it("keeps recently reset keys when dropping the oldest", () => {
    const limiter = limiterWith(2, 1_000);
    limiter.consume("old", "default", 10_000);
    limiter.consume("mid", "default", 10_100);
    limiter.consume("old", "default", 11_050);
    limiter.consume("new", "default", 11_060);

    expect(limiter.size()).toBeLessThanOrEqual(2);
    const decision = limiter.consume("new", "default", 11_070);
    expect(decision.remaining).toBe(decision.limit - 2);
  });

  it("keeps enforcing limits for keys that stay under the cap", () => {
    const limiter = new RateLimiter({
      ...baseConfig,
      RATE_LIMIT_ENABLED: true,
      RATE_LIMIT_DEFAULT_MAX: 2,
      RATE_LIMIT_WINDOW_MS: 60_000,
      RATE_LIMIT_MAX_TRACKED_KEYS: 100,
    } as never);

    expect(limiter.consume("x", "default", 1).allowed).toBe(true);
    expect(limiter.consume("x", "default", 2).allowed).toBe(true);
    expect(limiter.consume("x", "default", 3).allowed).toBe(false);
  });
});
