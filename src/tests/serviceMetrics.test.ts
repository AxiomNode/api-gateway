import { describe, expect, it } from "vitest";

import { ServiceMetrics } from "../app/services/serviceMetrics.js";

describe("ServiceMetrics", () => {
  it("tracks route counters in the aggregated snapshot and caps log history", () => {
    const metrics = new ServiceMetrics({
      SERVICE_NAME: "api-gateway",
      METRICS_LOG_BUFFER_SIZE: 2,
    } as never);

    metrics.recordIncomingRequest({
      method: "GET",
      route: "/v1/backoffice/services",
      statusCode: 200,
      durationMs: 42,
      requestBytes: 120,
      responseBytes: 480,
    });

    metrics.recordIncomingRequest({
      method: "POST",
      route: "/v1/mobile/games/quiz/generate",
      statusCode: 502,
      durationMs: 210,
      requestBytes: 256,
      responseBytes: 96,
    });

    metrics.recordLog("info", "gateway_started");
    metrics.recordLog("info", "request_completed", { route: "/v1/backoffice/services" });
    metrics.recordLog("error", "request_completed", { route: "/v1/mobile/games/quiz/generate" });

    expect(metrics.snapshot()).toMatchObject({
      traffic: {
        requestsReceivedTotal: 2,
        errorsTotal: 1,
      },
      requestsByRoute: expect.arrayContaining([
        expect.objectContaining({ method: "GET", route: "/v1/backoffice/services", statusCode: 200, total: 1 }),
        expect.objectContaining({ method: "POST", route: "/v1/mobile/games/quiz/generate", statusCode: 502, total: 1 }),
      ]),
    });

    expect(metrics.recentLogs()).toHaveLength(2);
    expect(metrics.recentLogs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "request_completed", level: "info" }),
        expect.objectContaining({ message: "request_completed", level: "error" }),
      ]),
    );
  });
});