import { afterEach, beforeEach, describe, expect, it } from "vitest";

import http from "node:http";

import { isUpstreamTimeoutError } from "@axiomnode/shared-sdk-client/proxy";
import Fastify, { type FastifyInstance } from "fastify";

import { proxyRoutes } from "../app/routes/proxy.js";

type Seen = { method?: string; url?: string; body: Buffer; contentType?: string; authorization?: string };

let upstream: http.Server | undefined;
let app: FastifyInstance | undefined;
const seen: Seen[] = [];

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function startUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
  upstream = http.createServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({
      method: req.method,
      url: req.url,
      body,
      contentType: req.headers["content-type"],
      authorization: req.headers.authorization,
    });
    handler(req, res);
  });
  await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

async function buildApp(baseUrl: string, overrides: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const instance = Fastify();
  instance.setErrorHandler((error, _request, reply) => {
    if (isUpstreamTimeoutError(error)) {
      reply.status(504).send({ message: "Upstream request timed out" });
      return;
    }
    reply.send(error);
  });
  await proxyRoutes(instance, {
    SERVICE_NAME: "api-gateway",
    SERVICE_PORT: 7005,
    NODE_ENV: "test",
    ALLOWED_ORIGINS: "http://localhost:3000",
    BFF_MOBILE_URL: baseUrl,
    BFF_BACKOFFICE_URL: baseUrl,
    EDGE_API_TOKEN: "",
    ...overrides,
  } as never);
  app = instance;
  return instance;
}

describe("raw passthrough on plain forwarding routes", () => {
  beforeEach(() => {
    seen.length = 0;
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream!.close(resolve));
      upstream = undefined;
    }
  });

  it("forwards the request body bytes and content-type untouched (POST)", async () => {
    const baseUrl = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const gateway = await buildApp(baseUrl);

    // Non-canonical on purpose: spacing, key order, duplicate keys and escapes do not survive parse/stringify.
    const original = '{ "b" : 1,  "a":"\\u00e9", "a": 2 }\n';
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/mobile/games/events",
      headers: { "content-type": "application/json; charset=utf-8", authorization: "Bearer player" },
      payload: original,
    });

    expect(response.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].body.equals(Buffer.from(original))).toBe(true);
    expect(seen[0].contentType).toBe("application/json; charset=utf-8");
    expect(seen[0].authorization).toBe("Bearer player");
  });

  it("returns the upstream body bytes, status and content-type untouched", async () => {
    const upstreamBody = '{ "z":1 ,"a" : "\\u00e9" }';
    const baseUrl = await startUpstream((_req, res) => {
      res.writeHead(201, { "content-type": "application/json; charset=utf-8" });
      res.end(upstreamBody);
    });
    const gateway = await buildApp(baseUrl);

    const response = await gateway.inject({ method: "GET", url: "/v1/mobile/games/categories" });

    expect(response.statusCode).toBe(201);
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.rawPayload.equals(Buffer.from(upstreamBody))).toBe(true);
  });

  it("keeps upstream error statuses and bodies", async () => {
    const baseUrl = await startUpstream((_req, res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end('{"message":"nope"}');
    });
    const gateway = await buildApp(baseUrl);

    const response = await gateway.inject({ method: "POST", url: "/v1/mobile/games/quiz/generate", payload: { a: 1 } });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ message: "nope" });
  });

  it("answers {} for an empty JSON upstream body, as JSON mode did", async () => {
    const baseUrl = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end();
    });
    const gateway = await buildApp(baseUrl);

    const response = await gateway.inject({ method: "GET", url: "/v1/mobile/games/categories" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it("forwards non-JSON upstream payloads and 204 responses", async () => {
    let call = 0;
    const baseUrl = await startUpstream((_req, res) => {
      call += 1;
      if (call === 1) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("plain text");
        return;
      }
      res.writeHead(204);
      res.end();
    });
    const gateway = await buildApp(baseUrl, { EDGE_API_TOKEN: "edge" });

    const text = await gateway.inject({ method: "GET", url: "/v1/mobile/games/categories" });
    const none = await gateway.inject({
      method: "DELETE",
      url: "/v1/backoffice/ai-engine/target",
      headers: { authorization: "Bearer edge" },
    });

    expect(text.statusCode).toBe(200);
    expect(text.body).toBe("plain text");
    expect(none.statusCode).toBe(204);
    expect(none.body).toBe("");
  });

  it("uses the shared forward path for PUT and keeps the body bytes", async () => {
    const baseUrl = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const gateway = await buildApp(baseUrl);

    const original = '{"enabled" :  true}';
    const response = await gateway.inject({
      method: "PUT",
      url: "/v1/mobile/player/profile",
      headers: { "content-type": "application/json" },
      payload: original,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].body.toString("utf8")).toBe(original);
  });

  it("sends no body when the client sent none", async () => {
    const baseUrl = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const gateway = await buildApp(baseUrl, { EDGE_API_TOKEN: "edge" });

    await gateway.inject({
      method: "POST",
      url: "/v1/backoffice/ai-diagnostics/tests/run",
      headers: { authorization: "Bearer edge" },
    });

    expect(seen[0].body.length).toBe(0);
  });

  it("leaves malformed request JSON to the upstream instead of parsing it at the gateway", async () => {
    const baseUrl = await startUpstream((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end('{"message":"upstream says no"}');
    });
    const gateway = await buildApp(baseUrl);

    const response = await gateway.inject({
      method: "POST",
      url: "/v1/mobile/games/events",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(seen[0].body.toString("utf8")).toBe("{not json");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "upstream says no" });
  });

  it("forwards text/plain bodies as sent, with their own content-type", async () => {
    const baseUrl = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const gateway = await buildApp(baseUrl);

    await gateway.inject({
      method: "POST",
      url: "/v1/mobile/games/events",
      headers: { "content-type": "text/plain" },
      payload: "hello",
    });

    expect(seen[0].body.toString("utf8")).toBe("hello");
    expect(seen[0].contentType).toBe("text/plain");
  });

  it("still rejects content types Fastify cannot parse with 415 at the gateway", async () => {
    const baseUrl = await startUpstream((_req, res) => {
      res.end("{}");
    });
    const gateway = await buildApp(baseUrl);

    const response = await gateway.inject({
      method: "POST",
      url: "/v1/mobile/games/events",
      headers: { "content-type": "application/x-unknown" },
      payload: "hello",
    });

    expect(response.statusCode).toBe(415);
    expect(seen).toHaveLength(0);
  });

  it("answers 504 when the upstream body stalls after headers (timeout covers the body)", async () => {
    const baseUrl = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial":');
    });
    const gateway = await buildApp(baseUrl, { UPSTREAM_TIMEOUT_MS: 200 });

    const response = await gateway.inject({ method: "GET", url: "/v1/mobile/games/categories" });

    expect(response.statusCode).toBe(504);
  });

  it("keeps validating query parameters on the JSON-mode routes", async () => {
    const baseUrl = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"items":[]}');
    });
    const gateway = await buildApp(baseUrl);

    const invalid = await gateway.inject({ method: "GET", url: "/v1/mobile/games/quiz/random?count=999" });
    const valid = await gateway.inject({ method: "GET", url: "/v1/mobile/games/quiz/random?count=3&language=es" });

    expect(invalid.statusCode).toBe(400);
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ items: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/v1/mobile/games/quiz/random?count=3");
  });
});
