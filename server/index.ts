import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import { BailianSession } from "./bailian.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

const webRoot = resolve("dist/web");
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

await app.register(fastifyWebsocket, { options: { maxPayload: 1 << 20 } });
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
} else {
  app.log.warn(`${webRoot} 不存在，先运行 vite build（npm run dev 会自动做）`);
}

app.get("/healthz", async () => ({ ok: true, model: config.model }));

app.get<{ Querystring: { token?: string } }>("/ws", { websocket: true }, (socket, req) => {
  if (config.accessToken && req.query.token !== config.accessToken) {
    socket.close(4401, "unauthorized");
    return;
  }
  handleClient(socket, req.log);
});

function handleClient(socket: WebSocket, log: typeof app.log) {
  const send = (msg: ServerMessage) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(msg));
  let upstream: BailianSession | null = null;

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      // M2：音频转发给 upstream
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "ping":
        send({ type: "pong", t: msg.t });
        break;
      case "start":
        if (upstream) return;
        send({ type: "state", upstream: "connecting" });
        upstream = new BailianSession({
          apiKey: config.apiKey,
          wsUrl: config.wsUrl,
          model: config.model,
          targetLanguage: config.targetLanguage,
          voice: config.voice,
          mode: msg.mode,
          phrases: msg.phrases,
        });
        upstream.on("ready", async () => {
          send({ type: "state", upstream: "ready" });
          // M0 只验证“浏览器 → 后端 → 百炼”能建立会话，随即收尾；M2 起改为持续转发
          send({ type: "state", upstream: "finishing" });
          await upstream?.finish();
        });
        upstream.on("error", (err) => {
          log.warn({ err: err.message }, "upstream error");
          send({ type: "error", message: err.message });
        });
        upstream.on("close", (code) => {
          send({ type: "state", upstream: "closed", detail: `code=${code}` });
          upstream = null;
        });
        break;
      case "stop":
        upstream?.finish();
        break;
    }
  });

  socket.on("close", () => upstream?.close());
}

await app.listen({ port: config.port, host: config.host });
