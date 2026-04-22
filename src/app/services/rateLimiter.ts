import type { AppConfig } from "../config.js";

/** @module rateLimiter — In-memory fixed-window rate limiter for the API Gateway. */

export type RateLimitCategory = "default" | "generation" | "auth" | "admin";

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
  category: RateLimitCategory;
};

type Bucket = {
  count: number;
  windowStart: number;
};

type CategoryConfig = {
  max: number;
  windowMs: number;
};

const SKIPPED_ROUTES = new Set(["/health", "/v1/health", "/monitor/stats", "/monitor/logs", "/metrics"]);

export function classifyRoute(method: string, route: string): RateLimitCategory | "skip" {
  if (SKIPPED_ROUTES.has(route)) {
    return "skip";
  }
  if (method === "OPTIONS") {
    return "skip";
  }
  if (route.startsWith("/internal/admin")) {
    return "admin";
  }
  if (route.includes("/generate") || route.includes("/ingest")) {
    return "generation";
  }
  if (route.startsWith("/v1/backoffice/auth")) {
    return "auth";
  }
  return "default";
}

/** Fixed-window per-key counter for lightweight rate limiting at the edge. */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly categories: Record<RateLimitCategory, CategoryConfig>;
  private readonly enabled: boolean;
  private readonly maxEntries: number;

  constructor(config: AppConfig) {
    this.enabled = config.RATE_LIMIT_ENABLED ?? true;
    const windowMs = config.RATE_LIMIT_WINDOW_MS ?? 60_000;
    this.maxEntries = config.RATE_LIMIT_MAX_TRACKED_KEYS ?? 10_000;
    this.categories = {
      default: { max: config.RATE_LIMIT_DEFAULT_MAX ?? 120, windowMs },
      generation: { max: config.RATE_LIMIT_GENERATION_MAX ?? 10, windowMs },
      auth: { max: config.RATE_LIMIT_AUTH_MAX ?? 30, windowMs },
      admin: { max: config.RATE_LIMIT_ADMIN_MAX ?? 30, windowMs },
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  limitFor(category: RateLimitCategory): CategoryConfig {
    return this.categories[category];
  }

  consume(key: string, category: RateLimitCategory, now: number = Date.now()): RateLimitDecision {
    const cfg = this.categories[category];
    if (!this.enabled) {
      return {
        allowed: true,
        remaining: cfg.max,
        limit: cfg.max,
        retryAfterSeconds: 0,
        category,
      };
    }

    const bucketKey = `${category}|${key}`;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket || now - bucket.windowStart >= cfg.windowMs) {
      bucket = { count: 0, windowStart: now };
      this.buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;

    if (this.buckets.size > this.maxEntries) {
      this.evictOldest(now);
    }

    if (bucket.count > cfg.max) {
      const retryAfterMs = cfg.windowMs - (now - bucket.windowStart);
      return {
        allowed: false,
        remaining: 0,
        limit: cfg.max,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        category,
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, cfg.max - bucket.count),
      limit: cfg.max,
      retryAfterSeconds: 0,
      category,
    };
  }

  reset(): void {
    this.buckets.clear();
  }

  size(): number {
    return this.buckets.size;
  }

  private evictOldest(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.categories.default.windowMs) {
        this.buckets.delete(key);
      }
    }
  }
}
