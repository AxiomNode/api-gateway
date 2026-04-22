import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../app/config.js";

describe("loadConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads defaults when optional values are omitted", () => {
    delete process.env.SERVICE_NAME;
    delete process.env.SERVICE_PORT;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.BFF_MOBILE_URL;
    delete process.env.BFF_BACKOFFICE_URL;
    delete process.env.AI_ENGINE_API_URL;
    delete process.env.AI_ENGINE_STATS_URL;

    const config = loadConfig();

    expect(config).toMatchObject({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://localhost:7010",
      BFF_BACKOFFICE_URL: "http://localhost:7011",
      AI_ENGINE_API_URL: "http://localhost:7001",
      AI_ENGINE_STATS_URL: "http://localhost:7000",
      UPSTREAM_TIMEOUT_MS: 15000,
      UPSTREAM_GENERATION_TIMEOUT_MS: 120000,
      EDGE_API_TOKEN: "",
      METRICS_LOG_BUFFER_SIZE: 1000,
    });
  });

  it("rejects invalid gateway configuration", () => {
    vi.stubEnv("SERVICE_PORT", "0");
    vi.stubEnv("BFF_MOBILE_URL", "not-a-url");

    expect(() => loadConfig()).toThrow("Invalid gateway configuration");
  });
});