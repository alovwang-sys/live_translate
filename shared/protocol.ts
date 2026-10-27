// 浏览器 ⇄ 后端 的消息定义。音频走二进制帧：
//   上行 PCM16 单声道 16 kHz；下行 PCM16 单声道 24 kHz。

export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

/** audio / audio+text / text：同传；asr：纯转写（只出原文，不翻译） */
export type Mode = "audio" | "audio+text" | "text" | "asr";

export type ClientMessage =
  | { type: "start"; mode: Mode; phrases?: Record<string, string>; /** 仅 asr：识别语种，不填自动识别 */ language?: string }
  | { type: "stop" }
  | { type: "ping"; t: number };

export type ServerMessage =
  | { type: "state"; upstream: "connecting" | "ready" | "finishing" | "closed"; detail?: string }
  | { type: "source"; itemId: string; text: string; final: boolean }
  | { type: "target"; itemId: string; text: string; final: boolean }
  /** 纯转写：text 是这句话目前的完整内容（整句替换，不是增量） */
  | { type: "asr"; itemId: string; text: string; final: boolean; language?: string }
  | { type: "speech"; event: "started" | "stopped" }
  | { type: "error"; message: string; code?: "busy" | "timeout" }
  | { type: "pong"; t: number };
