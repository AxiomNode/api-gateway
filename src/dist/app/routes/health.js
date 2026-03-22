export async function healthRoutes(app) {
    app.get("/health", async () => {
        return { status: "ok", service: "api-gateway" };
    });
    app.get("/v1/health", async () => {
        return { status: "ok", version: "v1" };
    });
}
