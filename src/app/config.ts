import { z } from "zod";

const ConfigSchema = z.object({
  SERVICE_NAME: z.string().default("api-gateway"),
  SERVICE_PORT: z.coerce.number().int().positive().default(7005),
  NODE_ENV: z.string().default("development"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000")
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error("Invalid gateway configuration");
  }
  return parsed.data;
}
