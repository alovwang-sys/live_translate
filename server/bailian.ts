// 百炼实时同传（qwen3.8-livetranslate-flash-realtime）的 WebSocket 客户端。
// 只做协议层：连接、配置会话、发音频、把服务端事件整理成几类回调。
// 续会话、重连等策略放在上层（server/session.ts，M3）。

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { Mode } from "../shared/protocol.js";

export interface BailianOptions {
  apiKey: string;
  wsUrl: string;
  model: string;
  targetLanguage: string;
  voice: string;
  mode: Mode;
  phrases?: Record<string, string>;
}

export interface BailianEvents {
  ready: [];
  raw: [event: Record<string, any>];
  speech: [kind: "started" | "stopped", event: Record<string, any>];
  source: [itemId: string, text: string, final: boolean];
  target: [itemId: string, text: string, final: boolean];
  audio: [pcm24k: Buffer, itemId: string];
  responseDone: [event: Record<string, any>];
  error: [err: Error];
  finished: [];
  close: [code: number, reason: string];
}

export class BailianSession extends EventEmitter<BailianEvents> {
  private ws: WebSocket;
  private isReady = false;
  private finishing = false;

  constructor(private opts: BailianOptions) {
    super();
    const url = `${opts.wsUrl}?model=${encodeURIComponent(opts.model)}`;
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("error", (err) => this.emit("error", err));
    this.ws.on("close", (code, reason) => this.emit("close", code, reason.toString()));
  }

  get ready() {
    return this.isReady;
  }

  /** 发送一段 PCM16 16 kHz 单声道音频。 */
  sendAudio(pcm16k: Buffer) {
    if (!this.isReady || this.finishing) return;
    this.send({ type: "input_audio_buffer.append", audio: pcm16k.toString("base64") });
  }

  /** 通知服务端音频已发完；等 session.finished（或超时）后关闭连接。 */
  finish(timeoutMs = 15000): Promise<void> {
    if (this.finishing) return Promise.resolve();
    this.finishing = true;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.close();
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.once("finished", done);
      this.once("close", done);
      this.send({ type: "session.finish" });
    });
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }

  private send(event: Record<string, unknown>) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  private sessionUpdate() {
    const { mode, targetLanguage, voice, phrases } = this.opts;
    this.send({
      type: "session.update",
      session: {
        output_modalities: mode === "text" ? ["text"] : ["text", "audio"],
        voice,
        translation: {
          language: targetLanguage,
          ...(phrases && Object.keys(phrases).length ? { corpus: { phrases } } : {}),
        },
      },
    });
  }

  private onMessage(text: string) {
    let e: Record<string, any>;
    try {
      e = JSON.parse(text);
    } catch {
      return;
    }
    this.emit("raw", e);

    switch (e.type) {
      case "session.created":
        this.sessionUpdate();
        break;
      case "session.updated":
        if (!this.isReady) {
          this.isReady = true;
          this.emit("ready");
        }
        break;
      case "session.finished":
        this.emit("finished");
        break;
      case "input_audio_buffer.speech_started":
        this.emit("speech", "started", e);
        break;
      case "input_audio_buffer.speech_stopped":
        this.emit("speech", "stopped", e);
        break;
      case "conversation.item.input_audio_transcription.delta":
        this.emit("source", e.item_id ?? "", e.delta ?? e.text ?? "", false);
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.emit("source", e.item_id ?? "", e.transcript ?? e.text ?? "", true);
        break;
      case "response.audio_transcript.delta":
      case "response.text.delta":
        this.emit("target", e.item_id ?? "", e.delta ?? "", false);
        break;
      case "response.audio_transcript.done":
      case "response.text.done":
        this.emit("target", e.item_id ?? "", e.transcript ?? e.text ?? "", true);
        break;
      case "response.audio.delta":
        if (e.delta) this.emit("audio", Buffer.from(e.delta, "base64"), e.item_id ?? "");
        break;
      case "response.done":
        this.emit("responseDone", e);
        break;
      case "error":
        this.emit("error", new Error(`${e.error?.code ?? e.code ?? "error"}: ${e.error?.message ?? e.message ?? text}`));
        break;
    }
  }
}
