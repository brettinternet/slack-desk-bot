export const DEFAULT_HEALTH_PORT = 3210;

export function startHealthServer(port = DEFAULT_HEALTH_PORT) {
  const startedAt = Date.now();
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      if (new URL(request.url).pathname !== "/healthz") {
        return new Response("Not found", { status: 404 });
      }
      return Response.json({ status: "ok", uptime_ms: Date.now() - startedAt });
    },
  });
}
