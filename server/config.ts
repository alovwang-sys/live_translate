import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.env.ENV_FILE ?? ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}，请在 .env 中填写（参考 .env.example）`);
  return value;
}

export const config = {
  apiKey: required("DASHSCOPE_API_KEY"),
  wsUrl: required("DASHSCOPE_WS_URL"),
  model: process.env.LIVETRANSLATE_MODEL ?? "qwen3.8-livetranslate-flash-realtime",
  targetLanguage: process.env.TARGET_LANGUAGE ?? "zh",
  voice: process.env.VOICE ?? "Tina",
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  accessToken: process.env.ACCESS_TOKEN ?? "",
};
