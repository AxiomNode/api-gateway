import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify from "fastify";
import { proxyRoutes } from "../app/routes/proxy.js";

let tempStateDir = "";
let defaultStateFile = "";

function withStateFile<T extends Record<string, unknown>>(config: T): T & { GATEWAY_ROUTING_STATE_FILE: string } {
  return {
    ...config,
    GATEWAY_ROUTING_STATE_FILE: defaultStateFile,
  };
}

describe("proxy routes", () => {
  beforeEach(async () => {
    tempStateDir = await mkdtemp(path.join(os.tmpdir(), "axiomnode-gateway-test-"));
    defaultStateFile = path.join(tempStateDir, "routing-state.json");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (tempStateDir) {
      await rm(tempStateDir, { recursive: true, force: true });
    }
    tempStateDir = "";
    defaultStateFile = "";
  });

  it("forwards mobile quiz random to bff-mobile", async () => {
    const app = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ source: "bff-mobile" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "",
    }));

    const response = await app.inject({
      method: "GET",
      url: "/v1/mobile/games/quiz/random?language=es",
      headers: { "x-correlation-id": "corr-1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ source: "bff-mobile" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bff-mobile:7010/v1/mobile/games/quiz/random?language=es",
      expect.objectContaining({ method: "GET" }),
    );

    await app.close();
  });

  it("keeps backoffice routes protected when edge token is configured and missing", async () => {
    const app = Fastify();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    }));

    const response = await app.inject({
      method: "GET",
      url: "/v1/backoffice/services",
    });

    expect(response.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("forwards POST body and authorization headers", async () => {
    const app = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/mobile/games/quiz/generate",
      headers: {
        authorization: "Bearer edge-secret",
        "x-correlation-id": "corr-post",
      },
      payload: { query: "science", language: "es" },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bff-mobile:7010/v1/mobile/games/quiz/generate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "science", language: "es" }),
        headers: expect.objectContaining({
          authorization: "Bearer edge-secret",
          "x-correlation-id": "corr-post",
        }),
      }),
    );

    await app.close();
  });

  it("allows mobile routes without edge token even when backoffice remains protected", async () => {
    const app = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ source: "bff-mobile" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    }));

    const response = await app.inject({
      method: "GET",
      url: "/v1/mobile/games/quiz/random?language=es",
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bff-mobile:7010/v1/mobile/games/quiz/random?language=es",
      expect.objectContaining({ method: "GET" }),
    );

    await app.close();
  });

  it("rejects invalid random-game query params before proxying", async () => {
    const app = Fastify();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "",
    }));

    const response = await app.inject({
      method: "GET",
      url: "/v1/mobile/games/quiz/random?categoryId=",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: "Invalid query parameters" });
    expect(fetchMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("forwards backoffice service data insertion", async () => {
    const app = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ item: { id: "entry-22" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/backoffice/services/microservice-quiz/data",
      headers: {
        authorization: "Bearer edge-secret",
      },
      payload: {
        dataset: "history",
        categoryId: "9",
        language: "es",
        difficultyPercentage: 60,
        content: { question: "Q" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bff-backoffice:7011/v1/backoffice/services/microservice-quiz/data",
      expect.objectContaining({ method: "POST" }),
    );

    await app.close();
  });

  it("forwards ai-engine probe requests to bff-backoffice", async () => {
    const app = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reachable: true, api: { ok: true }, stats: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/backoffice/ai-engine/probe",
      headers: {
        authorization: "Bearer edge-secret",
        "x-correlation-id": "corr-probe-1",
        "x-dev-firebase-uid": "admin-dev-uid",
      },
      payload: {
        host: "127.0.0.1",
        protocol: "http",
        apiPort: 7001,
        statsPort: 7000,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bff-backoffice:7011/v1/backoffice/ai-engine/probe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          host: "127.0.0.1",
          protocol: "http",
          apiPort: 7001,
          statsPort: 7000,
        }),
        headers: expect.objectContaining({
          authorization: "Bearer edge-secret",
          "x-correlation-id": "corr-probe-1",
          "x-dev-firebase-uid": "admin-dev-uid",
        }),
      }),
    );

    await app.close();
  });

  it("forwards ai-engine target management requests to bff-backoffice", async () => {
    const app = Fastify();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ source: "default" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ source: "override", host: "127.0.0.1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ source: "default" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    }));

    const getResponse = await app.inject({
      method: "GET",
      url: "/v1/backoffice/ai-engine/target",
      headers: { authorization: "Bearer edge-secret" },
    });

    const putResponse = await app.inject({
      method: "PUT",
      url: "/v1/backoffice/ai-engine/target",
      headers: { authorization: "Bearer edge-secret" },
      payload: {
        host: "127.0.0.1",
        protocol: "http",
        apiPort: 7001,
        statsPort: 7000,
      },
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/v1/backoffice/ai-engine/target",
      headers: { authorization: "Bearer edge-secret" },
    });

    expect(getResponse.statusCode).toBe(200);
    expect(putResponse.statusCode).toBe(200);
    expect(deleteResponse.statusCode).toBe(200);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://bff-backoffice:7011/v1/backoffice/ai-engine/target",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://bff-backoffice:7011/v1/backoffice/ai-engine/target",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          host: "127.0.0.1",
          protocol: "http",
          apiPort: 7001,
          statsPort: 7000,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://bff-backoffice:7011/v1/backoffice/ai-engine/target",
      expect.objectContaining({ method: "DELETE" }),
    );

    await app.close();
  });

  it("forwards backoffice game catalogs", async () => {
    const app = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ catalogs: { categories: [], languages: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    }));

    const response = await app.inject({
      method: "GET",
      url: "/v1/backoffice/services/microservice-quiz/catalogs",
      headers: {
        authorization: "Bearer edge-secret",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bff-backoffice:7011/v1/backoffice/services/microservice-quiz/catalogs",
      expect.objectContaining({ method: "GET" }),
    );

    await app.close();
  });

  it("forwards critical headers to backoffice routes", async () => {
    const app = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/backoffice/services/microservice-quiz/data",
      headers: {
        authorization: "Bearer edge-secret",
        "x-correlation-id": "corr-critical-1",
        "x-firebase-id-token": "firebase-token-abc",
        "x-api-key": "ai-key-xyz",
      },
      payload: {
        dataset: "history",
        categoryId: "9",
        language: "es",
        difficultyPercentage: 60,
        content: { question: "Q" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bff-backoffice:7011/v1/backoffice/services/microservice-quiz/data",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer edge-secret",
          "x-correlation-id": "corr-critical-1",
          "x-firebase-id-token": "firebase-token-abc",
          "x-api-key": "ai-key-xyz",
        }),
      }),
    );

    await app.close();
  });

  it("rejects invalid leaderboard query params before proxying", async () => {
    const app = Fastify();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    }));

    const response = await app.inject({
      method: "GET",
      url: "/v1/backoffice/users/leaderboard?limit=9999",
      headers: {
        authorization: "Bearer edge-secret",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: "Invalid query parameters" });
    expect(fetchMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("forwards backoffice service data deletion", async () => {
    const app = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    }));

    const response = await app.inject({
      method: "DELETE",
      url: "/v1/backoffice/services/microservice-wordpass/data/entry-9?dataset=history",
      headers: {
        authorization: "Bearer edge-secret",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bff-backoffice:7011/v1/backoffice/services/microservice-wordpass/data/entry-9?dataset=history",
      expect.objectContaining({ method: "DELETE" }),
    );

    await app.close();
  });

  it("forwards internal ai-engine generation through the persisted gateway target", async () => {
    const app = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      AI_ENGINE_API_URL: "http://ai-engine-api:8001",
      AI_ENGINE_STATS_URL: "http://ai-engine-stats:8000",
      EDGE_API_TOKEN: "",
    }));

    await app.inject({
      method: "PUT",
      url: "/internal/admin/ai-engine/target",
      payload: {
        host: "192.168.1.50",
        protocol: "http",
        apiPort: 17001,
        statsPort: 17000,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/ai-engine/generate/quiz?query=planetas&language=es",
      headers: {
        "x-api-key": "games-key",
        "x-correlation-id": "corr-ai-1",
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.50:17001/generate/quiz?query=planetas&language=es",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "games-key",
          "x-correlation-id": "corr-ai-1",
        }),
      }),
    );

    await app.close();
  });

  it("persists ai-engine target overrides in the gateway", async () => {
    const firstApp = Fastify();
    const secondApp = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const config = withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      AI_ENGINE_API_URL: "http://ai-engine-api:8001",
      AI_ENGINE_STATS_URL: "http://ai-engine-stats:8000",
      EDGE_API_TOKEN: "",
    });

    await proxyRoutes(firstApp, config);
    await firstApp.inject({
      method: "PUT",
      url: "/internal/admin/ai-engine/target",
      payload: {
        host: "10.0.0.12",
        protocol: "http",
        apiPort: 17001,
        statsPort: 17000,
        label: "gpu workstation",
      },
    });
    await firstApp.close();

    await proxyRoutes(secondApp, config);
    const response = await secondApp.inject({
      method: "GET",
      url: "/internal/admin/ai-engine/target",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: "override",
      host: "10.0.0.12",
      apiBaseUrl: "http://10.0.0.12:17001",
      statsBaseUrl: "http://10.0.0.12:17000",
      label: "gpu workstation",
    });

    await secondApp.close();
  });

  it("allows ai-engine targets outside the generic allowlist in the gateway", async () => {
    const app = Fastify();

    vi.stubGlobal("fetch", vi.fn());

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      AI_ENGINE_API_URL: "http://ai-engine-api:8001",
      AI_ENGINE_STATS_URL: "http://ai-engine-stats:8000",
      EDGE_API_TOKEN: "",
      ALLOWED_ROUTING_TARGET_HOSTS: "localhost,127.0.0.1,192.168.0.0/16",
    }));

    const response = await app.inject({
      method: "PUT",
      url: "/internal/admin/ai-engine/target",
      payload: {
        host: "example.com",
        apiPort: 17001,
        statsPort: 17000,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: "override",
      host: "example.com",
      apiBaseUrl: "http://example.com:17001",
      statsBaseUrl: "http://example.com:17000",
    });

    await app.close();
  });
});
