import { z } from "zod";

/** @module config — Environment-based configuration loader for the API Gateway. */

const ConfigSchema = z.object({
  SERVICE_NAME: z.string().default("api-gateway"),
  SERVICE_PORT: z.coerce.number().int().positive().default(7005),
  NODE_ENV: z.string().default("development"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  BFF_MOBILE_URL: z.string().url().default("http://localhost:7010"),
  BFF_BACKOFFICE_URL: z.string().url().default("http://localhost:7011"),
  AI_ENGINE_API_URL: z.string().url().default("http://localhost:7001"),
  AI_ENGINE_STATS_URL: z.string().url().default("http://localhost:7000"),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  UPSTREAM_GENERATION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(120000),
  EDGE_API_TOKEN: z.string().default(""),
  METRICS_LOG_BUFFER_SIZE: z.coerce.number().int().min(50).max(5000).default(1000),
  GATEWAY_ROUTING_STATE_FILE: z.string().min(1).optional(),
  ALLOWED_ROUTING_TARGET_HOSTS: z.string().min(1).optional(),
  API_GATEWAY_ADMIN_TOKEN: z.string().optional(),
});

type ParsedConfig = z.infer<typeof ConfigSchema>;

/** Application configuration type with optional override fields. */
export type AppConfig = Omit<
  ParsedConfig,
  | "AI_ENGINE_API_URL"
  | "AI_ENGINE_STATS_URL"
  | "METRICS_LOG_BUFFER_SIZE"
  | "UPSTREAM_TIMEOUT_MS"
  | "UPSTREAM_GENERATION_TIMEOUT_MS"
  | "GATEWAY_ROUTING_STATE_FILE"
  | "ALLOWED_ROUTING_TARGET_HOSTS"
  | "API_GATEWAY_ADMIN_TOKEN"
> & {
  AI_ENGINE_API_URL?: string;
  AI_ENGINE_STATS_URL?: string;
  METRICS_LOG_BUFFER_SIZE?: number;
  UPSTREAM_TIMEOUT_MS?: number;
  UPSTREAM_GENERATION_TIMEOUT_MS?: number;
  GATEWAY_ROUTING_STATE_FILE?: string;
  ALLOWED_ROUTING_TARGET_HOSTS?: string;
  API_GATEWAY_ADMIN_TOKEN?: string;
};

/** Parses and validates environment variables into a typed config object. */
export function loadConfig(): AppConfig {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error("Invalid gateway configuration");
  }
  return parsed.data;
}
