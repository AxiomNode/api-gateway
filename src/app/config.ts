import { z } from "zod";

const ConfigSchema = z.object({
  SERVICE_NAME: z.string().default("api-gateway"),
  SERVICE_PORT: z.coerce.number().int().positive().default(7005),
  NODE_ENV: z.string().default("development"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
  BFF_MOBILE_URL: z.string().url().default("http://localhost:7010"),
  BFF_BACKOFFICE_URL: z.string().url().default("http://localhost:7011"),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  EDGE_API_TOKEN: z.string().default(""),
  METRICS_LOG_BUFFER_SIZE: z.coerce.number().int().min(50).max(5000).default(1000),
});

type ParsedConfig = z.infer<typeof ConfigSchema>;

export type AppConfig = Omit<ParsedConfig, "METRICS_LOG_BUFFER_SIZE" | "UPSTREAM_TIMEOUT_MS"> & {
  METRICS_LOG_BUFFER_SIZE?: number;
  UPSTREAM_TIMEOUT_MS?: number;
};

export function loadConfig(): AppConfig {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error("Invalid gateway configuration");
  }
  return parsed.data;
}
