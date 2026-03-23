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
      payload: { topic: "science", language: "es" },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bff-mobile:7010/v1/mobile/games/quiz/generate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ topic: "science", language: "es" }),
        headers: expect.objectContaining({
          authorization: "Bearer edge-secret",
          "x-correlation-id": "corr-post",
        }),
      }),
    );

    vi.unstubAllGlobals();
    await app.close();
  });
});
