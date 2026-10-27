// 百炼实时语音识别（qwen3-asr-flash-realtime）的 WebSocket 客户端：只出原文，不翻译。
// 和 BailianSession 用同一套 Realtime 协议，但事件不同：
//   conversation.item.input_audio_transcription.text   中间结果，当前句预览 = text + stash（整句替换，不是增量）
//   conversation.item.input_audio_transcription.completed  一句话的最终结果（transcript）
// 服务端 VAD 断句，一个 item 就是一句话。

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export interface AsrOptions {
  apiKey: string;
  wsUrl: string;
  model: string;
  /** 识别语种，如 "en"、"zh"；不填则自动识别 */
  language?: string;
  /** 断句所需静音时长（ms） */
  silenceMs?: number;
}

export interface AsrEvents {
  ready: [];
  raw: [event: Record<string, any>];
  speech: [kind: "started" | "stopped", event: Record<string, any>];
  /** text 是这句话目前的完整内容（整句替换） */
  transcript: [itemId: string, text: string, final: boolean, language?: string];
  error: [err: Error];
  finished: [];
  close: [code: number, reason: string];
}

export class AsrSession extends EventEmitter<AsrEvents> {
  private ws: WebSocket;
  private isReady = false;
  private finishing = false;

  constructor(private opts: AsrOptions) {
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
    const { language, silenceMs } = this.opts;
    this.send({
      type: "session.update",
      session: {
        input_audio_format: "pcm",
        sample_rate: 16000,
        input_audio_transcription: language ? { language } : {},
        turn_detection: { type: "server_vad", threshold: 0.2, silence_duration_ms: silenceMs ?? 600 },
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
      case "conversation.item.input_audio_transcription.text":
        this.emit("transcript", e.item_id ?? "", `${e.text ?? ""}${e.stash ?? ""}`, false, e.language);
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.emit("transcript", e.item_id ?? "", e.transcript ?? "", true, e.language);
        break;
      case "error":
        this.emit("error", new Error(`${e.error?.code ?? e.code ?? "error"}: ${e.error?.message ?? e.message ?? text}`));
        break;
    }
  }
}
