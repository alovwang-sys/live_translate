// M1 链路验证：把一个英文 wav 按真实语速推给百炼，打印原文/译文，保存译音，统计延迟。
//
//   npm run probe -- samples/talk_en.wav [--mode audio|text] [--speed 1] [--in-gap 400] [--raw]
//
// 输出：
//   samples/<名字>.zh.wav          译音（24 kHz）
//   samples/<名字>.events.jsonl    服务端原始事件（音频内容已省略），用于核对协议字段

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { config } from "../server/config.js";
import { BailianSession } from "../server/bailian.js";
import { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, type Mode } from "../shared/protocol.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string", default: "audio" },
    speed: { type: "string", default: "1" },
    raw: { type: "boolean", default: false },
    "in-gap": { type: "string", default: "400" }, // 输入切句所需最短静音 ms
  },
});

const file = positionals[0] ?? "samples/talk_en.wav";
const mode = values.mode as Mode;
const speed = Number(values.speed);
const CHUNK_MS = 100;

function readWavPcm16Mono16k(path: string): Buffer {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path} 不是 WAV 文件`);
  }
  let offset = 12;
  let fmtOk = false;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      const format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (format !== 1 || channels !== 1 || rate !== INPUT_SAMPLE_RATE || bits !== 16) {
        throw new Error(
          `需要 16 kHz 单声道 PCM16，实际 format=${format} ch=${channels} rate=${rate} bits=${bits}。` +
            `可用：afconvert -f WAVE -d LEI16@16000 -c 1 in.xxx out.wav`,
        );
      }
      fmtOk = true;
    } else if (id === "data") {
      if (!fmtOk) throw new Error("WAV 缺少 fmt 块");
      return buf.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV 缺少 data 块");
}

function wavFromPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 返回每段有声音（前面至少有 minSilenceMs 静音）的起点，单位 ms（音频内位置）。 */
function voicedStarts(pcm: Buffer, rate: number, minSilenceMs: number): number[] {
  const frameMs = 20;
  const frameSamples = (rate * frameMs) / 1000;
  const starts: number[] = [];
  let silentMs = Infinity;
  for (let f = 0; (f + 1) * frameSamples * 2 <= pcm.length; f++) {
    let sum = 0;
    for (let i = 0; i < frameSamples; i++) {
      const s = pcm.readInt16LE((f * frameSamples + i) * 2);
      sum += s * s;
    }
    const voiced = Math.sqrt(sum / frameSamples) > 400;
    if (voiced) {
      if (silentMs >= minSilenceMs) starts.push(f * frameMs);
      silentMs = 0;
    } else {
      silentMs += frameMs;
    }
  }
  return starts;
}

/** 模拟播放器：每包到达后排在上一包之后播放。返回“输出音频内位置 ms → 播放时刻 ms”的映射。 */
function simulatePlayback(chunks: Buffer[], arrivals: number[]): (posMs: number) => number {
  const starts: { pos: number; play: number }[] = [];
  let pos = 0;
  let playEnd = 0;
  chunks.forEach((c, i) => {
    const dur = (c.length / 2 / OUTPUT_SAMPLE_RATE) * 1000;
    const play = Math.max(arrivals[i], playEnd);
    starts.push({ pos, play });
    pos += dur;
    playEnd = play + dur;
  });
  return (posMs) => {
    let k = 0;
    while (k + 1 < starts.length && starts[k + 1].pos <= posMs) k++;
    return starts[k].play + (posMs - starts[k].pos);
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms: number) => (ms / 1000).toFixed(2).padStart(6) + "s";

const pcmIn = readWavPcm16Mono16k(file);
const inputMs = (pcmIn.length / 2 / INPUT_SAMPLE_RATE) * 1000;
const stem = join(dirname(file), basename(file, extname(file)));

console.log(`文件 ${file}，时长 ${(inputMs / 1000).toFixed(1)}s，模式 ${mode}，语速 ×${speed}，模型 ${config.model}`);

const tConnect = performance.now();
let t0 = 0; // 开始发送音频的时刻
const now = () => performance.now() - t0;

const rawEvents: string[] = [];
const audioOut: Buffer[] = [];
const sources = new Map<string, string>();
const targets = new Map<string, string>();
const audioDeltaTimes: number[] = [];
let audioReceivedMs = 0;
// 译文流的累计文字，以及每次增长时已收到的译音长度（用于把文字锚点换算到译音位置）
let targetStream = "";
const targetMarks: { len: number; audioPosMs: number; t: number }[] = [];
const errors: string[] = [];

const session = new BailianSession({
  apiKey: config.apiKey,
  wsUrl: config.wsUrl,
  model: config.model,
  targetLanguage: config.targetLanguage,
  voice: config.voice,
  mode,
});

session.on("raw", (e) => {
  const copy = { ...e };
  if (copy.type === "response.audio.delta" && typeof copy.delta === "string") copy.delta = `<${copy.delta.length} b64 chars>`;
  rawEvents.push(JSON.stringify({ t: t0 ? Math.round(now()) : null, ...copy }));
  if (values.raw && copy.type !== "response.audio.delta") console.log("  [raw]", JSON.stringify(copy).slice(0, 300));
});
session.on("speech", (kind, e) => {
  console.log(`${fmt(now())}  ${kind === "started" ? "▶ 开始讲话" : "■ 停止讲话"}${e.speaker_id ? ` (${e.speaker_id})` : ""}`);
});
session.on("source", (id, text, final) => {
  if (final) {
    sources.set(id, text);
    console.log(`${fmt(now())}  原文 ${text}`);
  } else {
    sources.set(id, (sources.get(id) ?? "") + text);
  }
});
session.on("target", (id, text, final) => {
  if (!final && text) {
    targetStream += text;
    targetMarks.push({ len: targetStream.length, audioPosMs: audioReceivedMs, t: now() });
  }
  if (final) {
    if (text) targets.set(id, text);
    console.log(`${fmt(now())}  译文 ${targets.get(id) ?? text}`);
  } else {
    targets.set(id, (targets.get(id) ?? "") + text);
  }
});
session.on("audio", (pcm) => {
  audioDeltaTimes.push(now());
  audioReceivedMs += (pcm.length / 2 / OUTPUT_SAMPLE_RATE) * 1000;
  audioOut.push(pcm);
});
session.on("error", (err) => {
  errors.push(err.message);
  console.error(`${fmt(now())}  ✖ ${err.message}`);
});
session.on("close", (code, reason) => console.log(`${fmt(now())}  连接关闭 code=${code} ${reason}`));

await new Promise<void>((resolve, reject) => {
  session.once("ready", resolve);
  session.once("error", reject);
  session.once("close", (code, reason) => reject(new Error(`未就绪即关闭：${code} ${reason}`)));
});
const readyMs = performance.now() - tConnect;
console.log(`会话就绪，耗时 ${readyMs.toFixed(0)}ms\n`);

t0 = performance.now();
const chunkBytes = (INPUT_SAMPLE_RATE * 2 * CHUNK_MS) / 1000;
for (let off = 0, i = 0; off < pcmIn.length; off += chunkBytes, i++) {
  session.sendAudio(pcmIn.subarray(off, off + chunkBytes));
  const wait = t0 + ((i + 1) * CHUNK_MS) / speed - performance.now();
  if (wait > 0) await sleep(wait);
}
// 补 1.5 秒静音，帮助服务端判断最后一句结束
const silence = Buffer.alloc(chunkBytes);
for (let i = 0; i < 15; i++) {
  session.sendAudio(silence);
  await sleep(CHUNK_MS / speed);
}
const sentDoneAt = now();
console.log(`${fmt(sentDoneAt)}  音频发送完毕，发送 session.finish`);
await session.finish(30000);
const finishedAt = now();

// ---------- 汇总 ----------
const pcmOut = Buffer.concat(audioOut);
writeFileSync(`${stem}.events.jsonl`, rawEvents.join("\n") + "\n");
if (pcmOut.length) writeFileSync(`${stem}.zh.wav`, wavFromPcm16(pcmOut, OUTPUT_SAMPLE_RATE));

const outMs = (pcmOut.length / 2 / OUTPUT_SAMPLE_RATE) * 1000;
const typeCounts = new Map<string, number>();
for (const line of rawEvents) {
  const type = JSON.parse(line).type as string;
  typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
}

console.log("\n========== 汇总 ==========");
console.log(`连接→就绪           ${readyMs.toFixed(0)} ms`);
console.log(`输入音频            ${(inputMs / 1000).toFixed(1)} s（按 ×${speed} 发送）`);
console.log(`译音总时长          ${(outMs / 1000).toFixed(1)} s，共 ${audioDeltaTimes.length} 包`);
console.log(`发完→会话结束       ${((finishedAt - sentDoneAt) / 1000).toFixed(2)} s`);
console.log(`原文条数 / 译文条数  ${sources.size} / ${targets.size}`);
if (audioDeltaTimes.length) {
  console.log(`首个译音包          ${fmt(audioDeltaTimes[0])}（相对开始发送）`);
  const span = audioDeltaTimes[audioDeltaTimes.length - 1] - audioDeltaTimes[0];
  // >1 表示服务端生成译音比实时快；≈1 表示服务端按实时节奏下发，积压会留在服务端
  console.log(`译音下发速度        ×${(outMs / span).toFixed(2)}（${(outMs / 1000).toFixed(1)}s 译音在 ${(span / 1000).toFixed(1)}s 内下发）`);
}

// 逐句延迟：百炼按讲话人分条目（一个人连续讲 = 一个条目），所以逐句靠“文字锚点”对齐：
//   <样本名>.anchors.json 按顺序给出每句英文对应译文里的一个关键词。
//   输入句首：按静音切句（in-gap），换算成发送时刻。
//   译音句首：关键词出现在译文流时已收到的译音位置，经模拟播放器换算成播放时刻。
//   延迟 = 听到这句译音的时刻 − 这句原声被发出去的时刻。
const playback = pcmOut.length ? simulatePlayback(audioOut, audioDeltaTimes) : null;
const anchorsPath = `${stem}.anchors.json`;
if (existsSync(anchorsPath)) {
  const anchors: string[] = JSON.parse(readFileSync(anchorsPath, "utf8"));
  const inSegs = voicedStarts(pcmIn, INPUT_SAMPLE_RATE, Number(values["in-gap"])).map((ms) => ms / speed);
  let from = 0;
  const marks = anchors.map((word) => {
    const idx = targetStream.indexOf(word, from);
    if (idx < 0) return null;
    from = idx + word.length;
    return targetMarks.find((m) => m.len > idx) ?? null;
  });
  const report = (label: string, times: (number | null)[]) => {
    console.log(`${label}句首          ${times.map((t) => (t == null ? "?" : (t / 1000).toFixed(1))).join(" ")}`);
    if (inSegs.length !== anchors.length || times.some((t) => t == null)) {
      console.log(`  无法逐句配对：输入切出 ${inSegs.length} 句，锚点 ${anchors.length} 个，未命中 ${times.filter((t) => t == null).length} 个`);
      return;
    }
    const lags = inSegs.map((t, i) => (times[i] as number) - t);
    console.log(`${label}逐句延迟      ${lags.map((l) => (l / 1000).toFixed(2)).join(" / ")} s`);
    console.log(`  平均 ${(lags.reduce((x, y) => x + y, 0) / lags.length / 1000).toFixed(2)} s，最大 ${(Math.max(...lags) / 1000).toFixed(2)} s`);
  };
  console.log(`原声句首（发送）      ${inSegs.map((t) => (t / 1000).toFixed(1)).join(" ")}`);
  report("字幕", marks.map((m) => m?.t ?? null));
  if (playback) report("译音", marks.map((m) => (m ? playback(m.audioPosMs) : null)));
}
if (playback) {
  const playEnd = playback(outMs);
  console.log(`最后一句播完        ${fmt(playEnd)}（输入在 ${fmt(inputMs / speed)} 结束，尾部延迟 ${((playEnd - inputMs / speed) / 1000).toFixed(2)} s）`);
}

console.log("事件统计            " + [...typeCounts].map(([k, v]) => `${k}×${v}`).join(", "));
if (errors.length) console.log(`错误                ${errors.join(" | ")}`);
console.log(`\n已保存 ${stem}.events.jsonl${pcmOut.length ? `、${stem}.zh.wav` : ""}`);
