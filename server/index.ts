import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { config } from "./config.js";
import { activeSessions, handleClient } from "./relay.js";

const webRoot = resolve("dist/web");
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(fastifyWebsocket, { options: { maxPayload: 1 << 20 } });
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
} else {
  app.log.warn(`${webRoot} 不存在，先运行 vite build（npm run dev 会自动做）`);
}
// 本机调试：页面加 ?src=samples/xxx.wav 可用测试音频代替麦克风
if (process.env.SERVE_SAMPLES === "1") {
  await app.register(fastifyStatic, { root: resolve("samples"), prefix: "/samples/", decorateReply: false });
}

app.get("/healthz", async () => ({
  ok: true,
  model: config.model,
  active: activeSessions(),
  max: config.maxSessions,
}));

app.get<{ Querystring: { token?: string } }>("/ws", { websocket: true }, (socket, req) => {
  if (config.accessToken && req.query.token !== config.accessToken) {
    socket.close(4401, "unauthorized");
    return;
  }
  handleClient(socket, req.log);
});

await app.listen({ port: config.port, host: config.host });
