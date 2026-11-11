import { describe, expect, it } from "vitest";

import {
  assertSecureConfig,
  buildTrustProxy,
  bearerMatches,
  headerMatches,
  insecureModeWarnings,
  isPermissiveEnv,
  isTargetHostAllowed,
  missingTokens,
  parseTrustProxy,
  safeEqual,
} from "../app/services/security.js";

describe("isPermissiveEnv", () => {
  it("only treats development and test as permissive", () => {
    expect(isPermissiveEnv("development")).toBe(true);
    expect(isPermissiveEnv(" Test ")).toBe(true);
    expect(isPermissiveEnv("production")).toBe(false);
    expect(isPermissiveEnv("staging")).toBe(false);
    expect(isPermissiveEnv("")).toBe(false);
  });
});

describe("constant-time comparison", () => {
  it("compares equal and different strings of any length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("matches bearer and raw headers and rejects missing or repeated ones", () => {
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
    expect(bearerMatches("Bearer wrong", "s3cret")).toBe(false);
    expect(bearerMatches(undefined, "s3cret")).toBe(false);
    expect(bearerMatches(["Bearer s3cret"], "s3cret")).toBe(false);
    expect(headerMatches("s3cret", "s3cret")).toBe(true);
    expect(headerMatches("nope", "s3cret")).toBe(false);
    expect(headerMatches(undefined, "s3cret")).toBe(false);
  });
});

describe("credential validation", () => {
  const full = { EDGE_API_TOKEN: "a", API_GATEWAY_ADMIN_TOKEN: "b", INTERNAL_SERVICE_TOKEN: "c" };

  it("lists empty, blank and unset tokens", () => {
    expect(missingTokens({ NODE_ENV: "production", EDGE_API_TOKEN: "  " })).toEqual([
      "EDGE_API_TOKEN",
      "API_GATEWAY_ADMIN_TOKEN",
      "INTERNAL_SERVICE_TOKEN",
    ]);
    expect(missingTokens({ NODE_ENV: "production", ...full })).toEqual([]);
  });

  it("refuses to start outside development/test when a token is missing", () => {
    expect(() => assertSecureConfig({ NODE_ENV: "production", ...full, INTERNAL_SERVICE_TOKEN: "" })).toThrow(
      /INTERNAL_SERVICE_TOKEN/,
    );
    expect(() => assertSecureConfig({ NODE_ENV: "staging" })).toThrow(/EDGE_API_TOKEN/);
    expect(() => assertSecureConfig({ NODE_ENV: "production", ...full })).not.toThrow();
  });

  it("tolerates missing tokens in development and test but warns", () => {
    expect(() => assertSecureConfig({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertSecureConfig({ NODE_ENV: "test" })).not.toThrow();
    expect(insecureModeWarnings({ NODE_ENV: "development" })).toHaveLength(3);
    expect(insecureModeWarnings({ NODE_ENV: "development", ...full })).toEqual([]);
    expect(insecureModeWarnings({ NODE_ENV: "production" })).toEqual([]);
  });
});

describe("isTargetHostAllowed", () => {
  const list = "localhost, Example.com,10.0.0.0/8,192.168.1.0/24,bad/33,notanip/8";

  it("matches hostnames case-insensitively and IPv4 literals inside CIDRs", () => {
    expect(isTargetHostAllowed("LOCALHOST", list, "production")).toBe(true);
    expect(isTargetHostAllowed("example.com", list, "production")).toBe(true);
    expect(isTargetHostAllowed("10.20.30.40", list, "production")).toBe(true);
    expect(isTargetHostAllowed("192.168.1.77", list, "production")).toBe(true);
  });

  it("denies everything else, including metadata IPs and hostnames against CIDRs", () => {
    expect(isTargetHostAllowed("169.254.169.254", list, "production")).toBe(false);
    expect(isTargetHostAllowed("192.168.2.1", list, "production")).toBe(false);
    expect(isTargetHostAllowed("evil.example.net", list, "production")).toBe(false);
    expect(isTargetHostAllowed("internal.svc", "10.0.0.0/8", "production")).toBe(false);
    expect(isTargetHostAllowed("1.2.3.4", "bad/33", "production")).toBe(false);
  });

  it("supports a /0 and exact-IP entries", () => {
    expect(isTargetHostAllowed("8.8.8.8", "0.0.0.0/0", "production")).toBe(true);
    expect(isTargetHostAllowed("8.8.8.8", "8.8.8.8", "production")).toBe(true);
  });

  it("allows anything with an empty allowlist only in development/test", () => {
    expect(isTargetHostAllowed("anything.dev", undefined, "development")).toBe(true);
    expect(isTargetHostAllowed("anything.dev", " , ", "test")).toBe(true);
    expect(isTargetHostAllowed("anything.dev", undefined, "production")).toBe(false);
    expect(isTargetHostAllowed("anything.dev", "", "staging")).toBe(false);
  });
});

describe("parseTrustProxy", () => {
  it("defaults to false", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("FALSE")).toBe(false);
  });

  it("accepts true, hop counts and IP/CIDR lists", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("10.0.0.0/8, 172.16.0.0/12")).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
    expect(parseTrustProxy("127.0.0.1,::1,fd00::/8")).toEqual(["127.0.0.1", "::1", "fd00::/8"]);
  });

  it("rejects invalid values", () => {
    expect(() => parseTrustProxy("0")).toThrow(/hop count/);
    expect(() => parseTrustProxy("99")).toThrow(/hop count/);
    expect(() => parseTrustProxy("yes")).toThrow(/invalid entry/);
    expect(() => parseTrustProxy("10.0.0.0/33")).toThrow(/invalid entry/);
    expect(() => parseTrustProxy("10.0.0.0/8/8")).toThrow(/invalid entry/);
    expect(() => parseTrustProxy("10.0.0.0/x")).toThrow(/invalid entry/);
  });
});

describe("buildTrustProxy", () => {
  it("passes booleans and lists through and turns hop counts into a trust function", () => {
    expect(buildTrustProxy(undefined)).toBe(false);
    expect(buildTrustProxy("true")).toBe(true);
    expect(buildTrustProxy("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
    const fn = buildTrustProxy("2") as (address: string, hop: number) => boolean;
    expect([fn("a", 0), fn("a", 1), fn("a", 2)]).toEqual([true, true, false]);
  });
});
