import { z } from "zod";
const ConfigSchema = z.object({
    SERVICE_NAME: z.string().default("api-gateway"),
    SERVICE_PORT: z.coerce.number().int().positive().default(7005),
    NODE_ENV: z.string().default("development"),
    ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),
    BFF_MOBILE_URL: z.string().url().default("http://localhost:7010"),
    BFF_BACKOFFICE_URL: z.string().url().default("http://localhost:7011"),
    EDGE_API_TOKEN: z.string().default(""),
    METRICS_LOG_BUFFER_SIZE: z.coerce.number().int().min(50).max(5000).default(1000),
});
export function loadConfig() {
    const parsed = ConfigSchema.safeParse(process.env);
    if (!parsed.success) {
        throw new Error("Invalid gateway configuration");
    }
    return parsed.data;
}
