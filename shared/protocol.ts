// 浏览器 ⇄ 后端 的消息定义。音频走二进制帧：
//   上行 PCM16 单声道 16 kHz；下行 PCM16 单声道 24 kHz。

export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

export type Mode = "audio" | "audio+text" | "text";

export type ClientMessage =
  | { type: "start"; mode: Mode; phrases?: Record<string, string> }
  | { type: "stop" }
  | { type: "ping"; t: number };

export type ServerMessage =
  | { type: "state"; upstream: "connecting" | "ready" | "finishing" | "closed"; detail?: string }
  | { type: "source"; itemId: string; text: string; final: boolean }
  | { type: "target"; itemId: string; text: string; final: boolean }
  | { type: "speech"; event: "started" | "stopped" }
  | { type: "error"; message: string }
  | { type: "pong"; t: number };
