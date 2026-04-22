import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RoutingStateStore } from "../app/services/routingStateStore.js";

let tempDir = "";
let previousCwd = "";

describe("RoutingStateStore", () => {
  beforeEach(async () => {
    previousCwd = process.cwd();
    tempDir = await mkdtemp(path.join(os.tmpdir(), "axiomnode-api-gateway-state-"));
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    tempDir = "";
  });

  it("loads missing state as empty and persists updates", async () => {
    const stateFile = path.join(tempDir, "routing-state.json");
    const store = new RoutingStateStore({ GATEWAY_ROUTING_STATE_FILE: stateFile } as never);

    await store.load();
    expect(store.get("ai-engine-api")).toBeNull();

    await store.set("ai-engine-api", {
      baseUrl: "http://ai-engine-api:7001",
      label: "cluster",
      updatedAt: "2026-04-21T00:00:00.000Z",
    });

    expect(store.get("ai-engine-api")).toMatchObject({
      baseUrl: "http://ai-engine-api:7001",
      label: "cluster",
    });

    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    expect(persisted).toMatchObject({
      version: 1,
      overrides: {
        "ai-engine-api": {
          baseUrl: "http://ai-engine-api:7001",
          label: "cluster",
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
      },
    });

    await store.delete("ai-engine-api");
    expect(store.get("ai-engine-api")).toBeNull();
  });

  it("normalizes malformed persisted state and falls back to the default path when configured blank", async () => {
    process.chdir(tempDir);
    const runtimeDir = path.join(tempDir, ".runtime");
    const defaultStateFile = path.join(runtimeDir, "api-gateway-routing-state.json");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      defaultStateFile,
      JSON.stringify({
        version: 1,
        overrides: {
          "ai-engine-api": {
            baseUrl: "http://ai-engine-api:7001",
            updatedAt: "2026-04-21T00:00:00.000Z",
          },
          "ai-engine-stats": {
            baseUrl: 123,
            updatedAt: true,
          },
          invalid: null,
        },
      }),
      "utf8",
    );

    const store = new RoutingStateStore({ GATEWAY_ROUTING_STATE_FILE: "   " } as never);
    await store.load();

    expect(store.get("ai-engine-api")).toMatchObject({
      baseUrl: "http://ai-engine-api:7001",
      updatedAt: "2026-04-21T00:00:00.000Z",
    });
    expect(store.get("ai-engine-stats")).toBeNull();
  });

  it("falls back to empty state for null payloads and invalid versions", async () => {
    const nullStateFile = path.join(tempDir, "null-state.json");
    await writeFile(nullStateFile, "null", "utf8");

    const nullStore = new RoutingStateStore({ GATEWAY_ROUTING_STATE_FILE: nullStateFile } as never);
    await nullStore.load();
    expect(nullStore.get("ai-engine-api")).toBeNull();

    const invalidVersionStateFile = path.join(tempDir, "invalid-version-state.json");
    await writeFile(
      invalidVersionStateFile,
      JSON.stringify({ version: 2, overrides: { "ai-engine-api": { baseUrl: "http://ignored", updatedAt: "2026-04-21T00:00:00.000Z" } } }),
      "utf8",
    );

    const invalidVersionStore = new RoutingStateStore({ GATEWAY_ROUTING_STATE_FILE: invalidVersionStateFile } as never);
    await invalidVersionStore.load();
    expect(invalidVersionStore.get("ai-engine-api")).toBeNull();
  });

  it("rethrows filesystem errors other than missing-file", async () => {
    const store = new RoutingStateStore({ GATEWAY_ROUTING_STATE_FILE: tempDir } as never);

    await expect(store.load()).rejects.toMatchObject({ code: "EISDIR" });
  });
});