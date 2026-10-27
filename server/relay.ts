// 一个浏览器连接 ⇄ 一个百炼会话 的中转。
// 浏览器上行：start / stop 文本帧 + PCM16 16 kHz 二进制帧；
// 下行：原文、译文增量（文本帧）+ 译音 PCM16 24 kHz（二进制帧）。

import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import { BailianSession } from "./bailian.js";
import { AsrSession } from "./asr.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

/** 正在占用百炼会话的浏览器连接（用于并发上限）。 */
const active = new Set<WebSocket>();

/** 会话就绪前最多缓存的音频（100 ms 一包 → 约 15 s），避免开头丢字；建会话偶尔要 5–8 s。 */
const MAX_PENDING_CHUNKS = 150;

export function activeSessions() {
  return active.size;
}

export function handleClient(socket: WebSocket, log: FastifyBaseLogger) {
  const send = (msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  let upstream: BailianSession | AsrSession | null = null;
  let pending: Buffer[] = [];
  let startedAt = 0;
  let maxTimer: NodeJS.Timeout | undefined;

  const release = () => {
    active.delete(socket);
    clearTimeout(maxTimer);
  };

  const stop = async () => {
    if (!upstream) return;
    send({ type: "state", upstream: "finishing" });
    await upstream.finish();
  };

  const start = (msg: Extract<ClientMessage, { type: "start" }>) => {
    if (upstream) return;
    if (active.size >= config.maxSessions) {
      send({ type: "error", code: "busy", message: `当前已有 ${active.size} 人在使用，请稍后再试` });
      return;
    }
    active.add(socket);
    startedAt = Date.now();
    log.info({ mode: msg.mode, language: msg.language, active: active.size }, "session start");
    send({ type: "state", upstream: "connecting" });

    // 两种上游共用的事件处理
    const onReady = () => {
      send({ type: "state", upstream: "ready" });
      for (const chunk of pending) upstream?.sendAudio(chunk);
      pending = [];
    };
    const onSpeech = (kind: "started" | "stopped") => send({ type: "speech", event: kind });
    const onError = (err: Error) => {
      log.warn({ err: err.message }, "upstream error");
      send({ type: "error", message: err.message });
    };
    const onClose = (code: number, reason: string) => {
      log.info({ code, reason, seconds: Math.round((Date.now() - startedAt) / 1000) }, "session closed");
      send({ type: "state", upstream: "closed", detail: `code=${code}` });
      upstream = null;
      pending = [];
      release();
    };

    if (msg.mode === "asr") {
      const session = new AsrSession({
        apiKey: config.asrApiKey,
        wsUrl: config.wsUrl,
        model: config.asrModel,
        language: msg.language || undefined,
      });
      upstream = session;
      session.on("ready", onReady);
      session.on("speech", onSpeech);
      session.on("transcript", (itemId, text, final, language) => send({ type: "asr", itemId, text, final, language }));
      session.on("error", onError);
      session.on("close", onClose);
    } else {
      const session = new BailianSession({
        apiKey: config.apiKey,
        wsUrl: config.wsUrl,
        model: config.model,
        targetLanguage: config.targetLanguage,
        voice: config.voice,
        mode: msg.mode,
        phrases: msg.phrases,
      });
      upstream = session;
      session.on("ready", onReady);
      session.on("speech", onSpeech);
      session.on("source", (itemId, text, final) => send({ type: "source", itemId, text, final }));
      session.on("target", (itemId, text, final) => send({ type: "target", itemId, text, final }));
      session.on("audio", (pcm) => {
        if (socket.readyState === socket.OPEN) socket.send(pcm, { binary: true });
      });
      session.on("error", onError);
      session.on("close", onClose);
    }

    maxTimer = setTimeout(() => {
      send({ type: "error", code: "timeout", message: `单次使用已达 ${config.maxSessionMinutes} 分钟上限，已自动停止` });
      stop();
    }, config.maxSessionMinutes * 60_000);
  };

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!upstream) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (upstream.ready) upstream.sendAudio(chunk);
      else if (pending.length < MAX_PENDING_CHUNKS) pending.push(chunk);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "ping") send({ type: "pong", t: msg.t });
    else if (msg.type === "start") start(msg);
    else if (msg.type === "stop") stop();
  });

  socket.on("close", () => {
    upstream?.close();
    release();
  });
}
