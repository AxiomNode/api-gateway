import { describe, expect, it, vi } from "vitest";

import Fastify from "fastify";
import { proxyRoutes } from "../app/routes/proxy.js";

describe("proxy routes", () => {
  it("forwards mobile quiz random to bff-mobile", async () => {
    const app = Fastify();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ source: "bff-mobile" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, {
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "",
    });

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

    vi.unstubAllGlobals();
    await app.close();
  });

  it("rejects requests when edge token is configured and missing", async () => {
    const app = Fastify();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await proxyRoutes(app, {
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/mobile/games/quiz/random?language=es",
    });

    expect(response.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
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

    await proxyRoutes(app, {
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    });

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

    vi.unstubAllGlobals();
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

    await proxyRoutes(app, {
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    });

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

    vi.unstubAllGlobals();
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

    await proxyRoutes(app, {
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    });

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

    vi.unstubAllGlobals();
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

    await proxyRoutes(app, {
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    });

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

    vi.unstubAllGlobals();
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

    await proxyRoutes(app, {
      SERVICE_NAME: "api-gateway",
      SERVICE_PORT: 7005,
      NODE_ENV: "test",
      ALLOWED_ORIGINS: "http://localhost:3000",
      BFF_MOBILE_URL: "http://bff-mobile:7010",
      BFF_BACKOFFICE_URL: "http://bff-backoffice:7011",
      EDGE_API_TOKEN: "edge-secret",
    });

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

    vi.unstubAllGlobals();
    await app.close();
  });
});
