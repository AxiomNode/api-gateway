import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/** @module security — Shared auth and trust-proxy helpers (fail-closed by default). */

export type SecurityConfig = {
  NODE_ENV: string;
  EDGE_API_TOKEN?: string;
  INTERNAL_SERVICE_TOKEN?: string;
};

/** Only these NODE_ENV values may run with missing credentials. */
export function isPermissiveEnv(nodeEnv: string): boolean {
  const value = nodeEnv.trim().toLowerCase();
  return value === "development" || value === "test";
}

/** Constant-time string comparison (digests are compared so length is not leaked). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function bearerMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string") {
    return false;
  }
  return safeEqual(header, `Bearer ${token}`);
}

/** Constant-time check of a raw header value. */
export function headerMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string") {
    return false;
  }
  return safeEqual(header, token);
}

const REQUIRED_TOKENS = ["EDGE_API_TOKEN", "INTERNAL_SERVICE_TOKEN"] as const;

/** Names of required credentials that are empty or unset. */
export function missingTokens(config: SecurityConfig): string[] {
  return REQUIRED_TOKENS.filter((name) => !config[name]?.trim());
}

/** Throws when a non-development environment is missing a required credential. */
export function assertSecureConfig(config: SecurityConfig): void {
  if (isPermissiveEnv(config.NODE_ENV)) {
    return;
  }
  const missing = missingTokens(config);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to start with NODE_ENV=${config.NODE_ENV}: required credentials are empty: ${missing.join(", ")}`,
    );
  }
}

/** Human-readable warnings for permissive (development/test) runs with missing credentials. */
export function insecureModeWarnings(config: SecurityConfig): string[] {
  if (!isPermissiveEnv(config.NODE_ENV)) {
    return [];
  }
  return missingTokens(config).map(
    (name) => `${name} is empty: the matching routes are UNAUTHENTICATED (allowed only because NODE_ENV=${config.NODE_ENV})`,
  );
}

export type TrustProxySetting = boolean | number | string[];

/** Parses TRUST_PROXY: `true`/`false`, a hop count, or comma-separated IPs/CIDRs. Throws on invalid input. */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = (raw ?? "").trim();
  if (!value || value.toLowerCase() === "false") {
    return false;
  }
  if (value.toLowerCase() === "true") {
    return true;
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > 32) {
      throw new Error("TRUST_PROXY hop count must be between 1 and 32");
    }
    return hops;
  }

  const entries = value.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    const [address, prefix, ...rest] = entry.split("/");
    const family = isIP(address ?? "");
    const maxBits = family === 4 ? 32 : 128;
    const prefixOk =
      prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= maxBits && rest.length === 0);
    if (!family || !prefixOk) {
      throw new Error(`TRUST_PROXY contains an invalid entry: ${entry}`);
    }
  }
  return entries;
}

/**
 * Builds the value passed to Fastify's `trustProxy` option.
 * Hop counts become an explicit trust function because Fastify 5 treats a bare number as "trust nothing".
 * Hop counts cannot validate the immediate peer: use them only when the gateway is reachable solely via the proxy.
 */
export function buildTrustProxy(raw: string | undefined): boolean | string[] | ((address: string, hop: number) => boolean) {
  const setting = parseTrustProxy(raw);
  if (typeof setting === "number") {
    return (_address: string, hop: number) => hop < setting;
  }
  return setting;
}
