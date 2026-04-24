import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import cors from "@fastify/cors";
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

  it("allows CORS preflight for ai-engine preset updates", async () => {
    const app = Fastify();

    await app.register(cors, {
      origin: ["http://localhost:3000"],
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    });

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
      method: "OPTIONS",
      url: "/v1/backoffice/ai-engine/presets/workstation-public",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "PUT",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain("PUT");
    expect(response.headers["access-control-allow-methods"]).toContain("DELETE");

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

  it("rejects invalid wordpass random query params before proxying", async () => {
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
      url: "/v1/mobile/games/wordpass/random?categoryId=",
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
        port: 7002,
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
          port: 7002,
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
        port: 7002,
        label: "workstation-public",
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
          port: 7002,
          label: "workstation-public",
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

  it("forwards ai-engine preset management requests to bff-backoffice", async () => {
    const app = Fastify();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total: 1, presets: [{ id: "preset-1", name: "Preset 1", host: "127.0.0.1", protocol: "http", port: 7002 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "preset-2", name: "Preset 2", host: "10.0.0.5", protocol: "http", port: 17002 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "preset-2", name: "Preset 2 updated", host: "10.0.0.6", protocol: "https", port: 18443 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deleted: true, presetId: "preset-2" }), {
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
      url: "/v1/backoffice/ai-engine/presets",
      headers: { authorization: "Bearer edge-secret" },
    });

    const postResponse = await app.inject({
      method: "POST",
      url: "/v1/backoffice/ai-engine/presets",
      headers: { authorization: "Bearer edge-secret" },
      payload: {
        name: "Preset 2",
        host: "10.0.0.5",
        protocol: "http",
        port: 17002,
      },
    });

    const putResponse = await app.inject({
      method: "PUT",
      url: "/v1/backoffice/ai-engine/presets/preset-2",
      headers: { authorization: "Bearer edge-secret" },
      payload: {
        name: "Preset 2 updated",
        host: "10.0.0.6",
        protocol: "https",
        port: 18443,
      },
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/v1/backoffice/ai-engine/presets/preset-2",
      headers: { authorization: "Bearer edge-secret" },
    });

    expect(getResponse.statusCode).toBe(200);
    expect(postResponse.statusCode).toBe(201);
    expect(putResponse.statusCode).toBe(200);
    expect(deleteResponse.statusCode).toBe(200);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://bff-backoffice:7011/v1/backoffice/ai-engine/presets",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://bff-backoffice:7011/v1/backoffice/ai-engine/presets",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Preset 2",
          host: "10.0.0.5",
          protocol: "http",
          port: 17002,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://bff-backoffice:7011/v1/backoffice/ai-engine/presets/preset-2",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          name: "Preset 2 updated",
          host: "10.0.0.6",
          protocol: "https",
          port: 18443,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://bff-backoffice:7011/v1/backoffice/ai-engine/presets/preset-2",
      expect.objectContaining({ method: "DELETE" }),
    );

    await app.close();
  });

  it("forwards ai diagnostics routes to bff-backoffice", async () => {
    const app = Fastify();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ total_chunks: 12, coverage_level: "good", sources: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "running" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "completed", suites: {}, summary: { total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 } }), {
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

    const ragResponse = await app.inject({
      method: "GET",
      url: "/v1/backoffice/ai-diagnostics/rag/stats",
      headers: { authorization: "Bearer edge-secret" },
    });

    const runResponse = await app.inject({
      method: "POST",
      url: "/v1/backoffice/ai-diagnostics/tests/run",
      headers: { authorization: "Bearer edge-secret" },
      payload: {},
    });

    const statusResponse = await app.inject({
      method: "GET",
      url: "/v1/backoffice/ai-diagnostics/tests/status",
      headers: { authorization: "Bearer edge-secret" },
    });

    expect(ragResponse.statusCode).toBe(200);
    expect(runResponse.statusCode).toBe(200);
    expect(statusResponse.statusCode).toBe(200);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://bff-backoffice:7011/v1/backoffice/ai-diagnostics/rag/stats",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://bff-backoffice:7011/v1/backoffice/ai-diagnostics/tests/run",
      expect.objectContaining({ method: "POST", body: JSON.stringify({}) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://bff-backoffice:7011/v1/backoffice/ai-diagnostics/tests/status",
      expect.objectContaining({ method: "GET" }),
    );

    await app.close();
  });

  it("forwards backoffice operational summary requests", async () => {
    const app = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ totals: { total: 8, onlineCount: 7, accessIssues: 0, connectionErrors: 1 }, rows: [] }), {
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
      url: "/v1/backoffice/services/operational-summary",
      headers: {
        authorization: "Bearer edge-secret",
        "x-correlation-id": "corr-summary-1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bff-backoffice:7011/v1/backoffice/services/operational-summary",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer edge-secret",
          "x-correlation-id": "corr-summary-1",
        }),
      }),
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

  it("forwards internal ai-engine auxiliary routes", async () => {
    const app = Fastify();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ingested: 2 }), { status: 202, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ingested: 3 }), { status: 202, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ categories: [], languages: [] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "llama", uptime: 123 }), { status: 200, headers: { "content-type": "application/json" } }));

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

    const generateWordPass = await app.inject({
      method: "POST",
      url: "/internal/ai-engine/generate/word-pass?query=capitales&language=es",
      payload: { requestedBy: "api" },
    });
    const ingestQuiz = await app.inject({
      method: "POST",
      url: "/internal/ai-engine/ingest/quiz",
      payload: { documents: [{ content: "quiz doc" }] },
    });
    const ingestWordPass = await app.inject({
      method: "POST",
      url: "/internal/ai-engine/ingest/word-pass",
      payload: { documents: [{ content: "wordpass doc" }] },
    });
    const catalogs = await app.inject({ method: "GET", url: "/internal/ai-engine/catalogs" });
    const health = await app.inject({ method: "GET", url: "/internal/ai-engine/health" });
    const stats = await app.inject({ method: "GET", url: "/internal/ai-engine/stats?window=15m" });

    expect(generateWordPass.statusCode).toBe(200);
    expect(ingestQuiz.statusCode).toBe(202);
    expect(ingestWordPass.statusCode).toBe(202);
    expect(catalogs.statusCode).toBe(200);
    expect(health.statusCode).toBe(200);
    expect(stats.statusCode).toBe(200);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://ai-engine-api:8001/generate/word-pass?query=capitales&language=es",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://ai-engine-api:8001/ingest/quiz",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://ai-engine-api:8001/ingest/word-pass",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://ai-engine-api:8001/catalogs",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "http://ai-engine-api:8001/health",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "http://ai-engine-stats:8000/stats?window=15m",
      expect.objectContaining({ method: "GET" }),
    );

    await app.close();
  });

  it("forwards backoffice auth, admin and service inspection routes", async () => {
    const app = Fastify();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ created: true }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { uid: "u1" } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ totals: { total: 1 } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ inserted: true }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ roles: [] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ firebaseUid: "uid-1", role: "admin" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ services: [] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total: 1, metrics: [] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total: 1, logs: [] }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total: 1, items: [] }), { status: 200, headers: { "content-type": "application/json" } }));

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

    const commonHeaders = {
      authorization: "Bearer edge-secret",
      "x-correlation-id": "corr-backoffice-bulk",
    };

    const authSession = await app.inject({ method: "POST", url: "/v1/backoffice/auth/session", headers: commonHeaders, payload: { idToken: "firebase-token" } });
    const authMe = await app.inject({ method: "GET", url: "/v1/backoffice/auth/me", headers: commonHeaders });
    const monitorStats = await app.inject({ method: "GET", url: "/v1/backoffice/monitor/stats?window=1h", headers: commonHeaders });
    const manualEvent = await app.inject({ method: "POST", url: "/v1/backoffice/users/events/manual", headers: commonHeaders, payload: { type: "won" } });
    const roles = await app.inject({ method: "GET", url: "/v1/backoffice/admin/users/roles", headers: commonHeaders });
    const patchRole = await app.inject({ method: "PATCH", url: "/v1/backoffice/admin/users/roles/uid-1", headers: commonHeaders, payload: { role: "admin" } });
    const services = await app.inject({ method: "GET", url: "/v1/backoffice/services", headers: commonHeaders });
    const metrics = await app.inject({ method: "GET", url: "/v1/backoffice/services/microservice-quiz/metrics?limit=5", headers: commonHeaders });
    const logs = await app.inject({ method: "GET", url: "/v1/backoffice/services/microservice-quiz/logs?limit=10", headers: commonHeaders });
    const data = await app.inject({ method: "GET", url: "/v1/backoffice/services/microservice-quiz/data?dataset=history&page=2", headers: commonHeaders });

    expect(authSession.statusCode).toBe(201);
    expect(authMe.statusCode).toBe(200);
    expect(monitorStats.statusCode).toBe(200);
    expect(manualEvent.statusCode).toBe(201);
    expect(roles.statusCode).toBe(200);
    expect(patchRole.statusCode).toBe(200);
    expect(services.statusCode).toBe(200);
    expect(metrics.statusCode).toBe(200);
    expect(logs.statusCode).toBe(200);
    expect(data.statusCode).toBe(200);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://bff-backoffice:7011/v1/backoffice/auth/session", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://bff-backoffice:7011/v1/backoffice/auth/me", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "http://bff-backoffice:7011/v1/backoffice/monitor/stats?window=1h", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "http://bff-backoffice:7011/v1/backoffice/users/events/manual", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "http://bff-backoffice:7011/v1/backoffice/admin/users/roles", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(6, "http://bff-backoffice:7011/v1/backoffice/admin/users/roles/uid-1", expect.objectContaining({ method: "PATCH" }));
    expect(fetchMock).toHaveBeenNthCalledWith(7, "http://bff-backoffice:7011/v1/backoffice/services", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(8, "http://bff-backoffice:7011/v1/backoffice/services/microservice-quiz/metrics?limit=5", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(9, "http://bff-backoffice:7011/v1/backoffice/services/microservice-quiz/logs?limit=10", expect.objectContaining({ method: "GET" }));
    expect(fetchMock).toHaveBeenNthCalledWith(10, "http://bff-backoffice:7011/v1/backoffice/services/microservice-quiz/data?dataset=history&page=2", expect.objectContaining({ method: "GET" }));

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

  it("protects internal admin ai-engine target routes with the gateway admin token", async () => {
    const app = Fastify();

    vi.stubGlobal("fetch", vi.fn());

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      API_GATEWAY_ADMIN_TOKEN: "gateway-admin",
      EDGE_API_TOKEN: "",
    }));

    const getResponse = await app.inject({ method: "GET", url: "/internal/admin/ai-engine/target" });
    const putResponse = await app.inject({ method: "PUT", url: "/internal/admin/ai-engine/target", payload: { host: "localhost" } });
    const deleteResponse = await app.inject({ method: "DELETE", url: "/internal/admin/ai-engine/target" });

    expect(getResponse.statusCode).toBe(401);
    expect(putResponse.statusCode).toBe(401);
    expect(deleteResponse.statusCode).toBe(401);

    await app.close();
  });

  it("rejects unauthorized access across the remaining protected backoffice proxy routes", async () => {
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

    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/v1/backoffice/auth/session" }),
      app.inject({ method: "GET", url: "/v1/backoffice/auth/me" }),
      app.inject({ method: "GET", url: "/v1/backoffice/users/leaderboard" }),
      app.inject({ method: "GET", url: "/v1/backoffice/monitor/stats" }),
      app.inject({ method: "POST", url: "/v1/backoffice/users/events/manual" }),
      app.inject({ method: "GET", url: "/v1/backoffice/admin/users/roles" }),
      app.inject({ method: "PATCH", url: "/v1/backoffice/admin/users/roles/uid-1" }),
      app.inject({ method: "GET", url: "/v1/backoffice/services/operational-summary" }),
      app.inject({ method: "GET", url: "/v1/backoffice/ai-engine/target" }),
      app.inject({ method: "PUT", url: "/v1/backoffice/ai-engine/target" }),
      app.inject({ method: "DELETE", url: "/v1/backoffice/ai-engine/target" }),
      app.inject({ method: "GET", url: "/v1/backoffice/ai-engine/presets" }),
      app.inject({ method: "POST", url: "/v1/backoffice/ai-engine/presets" }),
      app.inject({ method: "PUT", url: "/v1/backoffice/ai-engine/presets/preset-1" }),
      app.inject({ method: "DELETE", url: "/v1/backoffice/ai-engine/presets/preset-1" }),
      app.inject({ method: "POST", url: "/v1/backoffice/ai-engine/probe" }),
      app.inject({ method: "GET", url: "/v1/backoffice/ai-diagnostics/rag/stats" }),
      app.inject({ method: "POST", url: "/v1/backoffice/ai-diagnostics/tests/run", payload: {} }),
      app.inject({ method: "GET", url: "/v1/backoffice/ai-diagnostics/tests/status" }),
      app.inject({ method: "GET", url: "/v1/backoffice/services/microservice-quiz/metrics" }),
      app.inject({ method: "GET", url: "/v1/backoffice/services/microservice-quiz/logs" }),
      app.inject({ method: "GET", url: "/v1/backoffice/services/microservice-quiz/data" }),
      app.inject({ method: "GET", url: "/v1/backoffice/services/microservice-quiz/catalogs" }),
      app.inject({ method: "POST", url: "/v1/backoffice/services/microservice-quiz/data" }),
      app.inject({ method: "DELETE", url: "/v1/backoffice/services/microservice-quiz/data/entry-1" }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Unauthorized" });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await app.close();
  });

  it("validates and normalizes internal admin ai-engine targets from env and overrides", async () => {
    const app = Fastify();

    vi.stubGlobal("fetch", vi.fn());

    await proxyRoutes(app, withStateFile({
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      AI_ENGINE_API_URL: "https://engine.example.com",
      AI_ENGINE_STATS_URL: "not-a-valid-url",
      API_GATEWAY_ADMIN_TOKEN: "gateway-admin",
      EDGE_API_TOKEN: "",
    }));

    const initial = await app.inject({
      method: "GET",
      url: "/internal/admin/ai-engine/target",
      headers: { authorization: "Bearer gateway-admin" },
    });
    const invalidPayload = await app.inject({
      method: "PUT",
      url: "/internal/admin/ai-engine/target",
      headers: { authorization: "Bearer gateway-admin" },
      payload: {},
    });
    const invalidHost = await app.inject({
      method: "PUT",
      url: "/internal/admin/ai-engine/target",
      headers: { authorization: "Bearer gateway-admin" },
      payload: { host: "http://bad host/path" },
    });
    const updated = await app.inject({
      method: "PUT",
      url: "/internal/admin/ai-engine/target",
      headers: { authorization: "Bearer gateway-admin" },
      payload: { host: " https://edge-box.local/path ", protocol: "https", apiPort: 18443, statsPort: 18080, label: "  remote box  " },
    });
    const reset = await app.inject({
      method: "DELETE",
      url: "/internal/admin/ai-engine/target",
      headers: { authorization: "Bearer gateway-admin" },
    });

    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      source: "env",
      host: "engine.example.com",
      protocol: "https",
      apiPort: 443,
      statsPort: null,
    });
    expect(invalidPayload.statusCode).toBe(400);
    expect(invalidPayload.json()).toMatchObject({ message: "Invalid payload" });
    expect(invalidHost.statusCode).toBe(400);
    expect(invalidHost.json()).toMatchObject({ message: "host must be a valid hostname or IPv4 address" });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      source: "override",
      host: "edge-box.local",
      protocol: "https",
      apiBaseUrl: "https://edge-box.local:18443",
      statsBaseUrl: "https://edge-box.local:18080",
      label: "remote box",
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      source: "env",
      host: "engine.example.com",
      protocol: "https",
      apiPort: 443,
    });

    await app.close();
  });

  it("handles special PUT proxy responses including text and invalid json payloads", async () => {
    const app = Fastify();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("updated", { status: 202, headers: { "content-type": "text/plain" } }))
      .mockResolvedValueOnce(new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }));

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

    const textResponse = await app.inject({
      method: "PUT",
      url: "/v1/backoffice/ai-engine/target",
      headers: { authorization: "Bearer edge-secret" },
    });
    const invalidJsonResponse = await app.inject({
      method: "PUT",
      url: "/v1/backoffice/ai-engine/presets/preset-json",
      headers: { authorization: "Bearer edge-secret" },
      payload: { enabled: true },
    });

    expect(textResponse.statusCode).toBe(202);
    expect(textResponse.body).toBe("updated");
    expect(invalidJsonResponse.statusCode).toBe(200);
    expect(invalidJsonResponse.json()).toEqual({});
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://bff-backoffice:7011/v1/backoffice/ai-engine/target",
      expect.objectContaining({ method: "PUT", body: undefined }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://bff-backoffice:7011/v1/backoffice/ai-engine/presets/preset-json",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true }) }),
    );

    await app.close();
  });

  it("accepts omitted query objects on validated random and leaderboard routes", async () => {
    const app = Fastify();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ source: "quiz-default" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ total: 0, rows: [] }), { status: 200, headers: { "content-type": "application/json" } }));

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

    const randomResponse = await app.inject({
      method: "GET",
      url: "/v1/mobile/games/wordpass/random",
    });
    const leaderboardResponse = await app.inject({
      method: "GET",
      url: "/v1/backoffice/users/leaderboard",
      headers: { authorization: "Bearer edge-secret" },
    });

    expect(randomResponse.statusCode).toBe(200);
    expect(leaderboardResponse.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://bff-mobile:7010/v1/mobile/games/wordpass/random",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://bff-backoffice:7011/v1/backoffice/users/leaderboard",
      expect.objectContaining({ method: "GET" }),
    );

    await app.close();
  });
});
