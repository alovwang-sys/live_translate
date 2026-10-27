// 纯转写（qwen3-asr-flash-realtime）链路验证：把 wav 按真实语速推给百炼，打印逐句识别结果和延迟。
//
//   npm run probe:asr -- samples/talk_en.wav [--language en] [--speed 1]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { config } from "../server/config.js";
import { AsrSession } from "../server/asr.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { language: { type: "string" }, speed: { type: "string", default: "1" }, raw: { type: "boolean", default: false } },
});
const file = positionals[0] ?? "samples/talk_en.wav";
const speed = Number(values.speed);

// 与 probe.ts 一样只接受 16 kHz 单声道 PCM16 wav：找到 data 块即可
const buf = readFileSync(file);
let off = 12;
let pcm = Buffer.alloc(0);
while (off + 8 <= buf.length) {
  const id = buf.toString("ascii", off, off + 4);
  const size = buf.readUInt32LE(off + 4);
  if (id === "data") {
    pcm = buf.subarray(off + 8, off + 8 + size);
    break;
  }
  off += 8 + size + (size % 2);
}
const inputSec = pcm.length / 32000;
console.log(`文件 ${file}，${inputSec.toFixed(1)}s，模型 ${config.asrModel}，语种 ${values.language ?? "自动"}`);

const tConnect = performance.now();
let t0 = 0;
const now = () => performance.now() - t0;
const fmt = (ms: number) => (ms / 1000).toFixed(2).padStart(6) + "s";
const finals: { t: number; text: string }[] = [];
let partials = 0;
const counts = new Map<string, number>();

const s = new AsrSession({ apiKey: config.asrApiKey, wsUrl: config.wsUrl, model: config.asrModel, language: values.language });
s.on("raw", (e) => {
  counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  if (values.raw) console.log("  [raw]", JSON.stringify(e).slice(0, 300));
});
s.on("transcript", (_id, text, final, lang) => {
  if (final) {
    finals.push({ t: now(), text });
    console.log(`${fmt(now())}  ✔ [${lang ?? "?"}] ${text}`);
  } else partials++;
});
s.on("error", (err) => console.error(`${fmt(now())}  ✖ ${err.message}`));

await new Promise<void>((resolve, reject) => {
  s.once("ready", resolve);
  s.once("close", (c, r) => reject(new Error(`未就绪即关闭：${c} ${r}`)));
});
console.log(`会话就绪 ${(performance.now() - tConnect).toFixed(0)}ms\n`);

t0 = performance.now();
const chunk = 3200;
for (let o = 0, i = 0; o < pcm.length; o += chunk, i++) {
  s.sendAudio(pcm.subarray(o, o + chunk));
  const wait = t0 + ((i + 1) * 100) / speed - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
const sentAt = now();
await s.finish(20000);
console.log(`\n发完→会话结束 ${((now() - sentAt) / 1000).toFixed(2)}s；最终句数 ${finals.length}，中间结果 ${partials} 次`);
console.log("事件统计 " + [...counts].map(([k, v]) => `${k}×${v}`).join(", "));
console.log("\n全文：\n" + finals.map((f) => f.text).join(" "));
