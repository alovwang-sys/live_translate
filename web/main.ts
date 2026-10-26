import type { ClientMessage, Mode, ServerMessage } from "../shared/protocol";
import { AudioPipeline, listMicrophones, looksLikeBluetooth } from "./audio";
import { EN_ENDERS, SubtitleTrack, ZH_ENDERS } from "./subtitles";
import {
  clearRecord,
  copyText,
  describe,
  downloadText,
  fileName,
  formatRecord,
  loadRecord,
  saveRecord,
  type TranscriptRecord,
} from "./record";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  main: $<HTMLButtonElement>("btn-main"),
  setup: $("setup"),
  mic: $<HTMLSelectElement>("mic"),
  processing: $<HTMLInputElement>("processing"),
  notice: $("notice"),
  meter: $("meter-bar"),
  inputLabel: $("input-label"),
  subs: $("subs"),
  tokenBox: $("token-box"),
  tokenInput: $<HTMLInputElement>("token-input"),
  tokenSave: $<HTMLButtonElement>("token-save"),
  log: $("log"),
  dSent: $("d-sent"),
  dBacklog: $("d-backlog"),
  dRate: $("d-rate"),
  dDropped: $("d-dropped"),
  dRtt: $("d-rtt"),
};

const target = new SubtitleTrack($("sub-target"), ZH_ENDERS, "");
const source = new SubtitleTrack($("sub-source"), EN_ENDERS, " ", 3);

// ---------- 同传记录（复制 / 下载 / 本机保存） ----------
let record: TranscriptRecord | null = loadRecord();
let saveTimer: number | undefined;

function syncRecord() {
  if (!record || phase === "idle") return;
  record.source = source.text();
  record.target = target.text();
  renderRecord();
  // 进行中每 3 秒存一次，页面意外关闭也能找回大部分内容
  if (saveTimer === undefined) {
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      if (record) saveRecord(record);
    }, 3000);
  }
}
target.onChange = syncRecord;
source.onChange = syncRecord;

function renderRecord() {
  const box = $("record");
  box.hidden = !record || (!record.source && !record.target);
  if (!record || box.hidden) return;
  $("record-meta").textContent = describe(record);
  $("record-stats").textContent = `译文 ${record.target.length} 字 · 原文 ${record.source.split(/\s+/).filter(Boolean).length} 词`;
}
renderRecord();

function finalizeRecord() {
  if (!record) return;
  target.flush();
  source.flush();
  record.source = source.text();
  record.target = target.text();
  record.endedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (record.source || record.target) saveRecord(record);
  else record = loadRecord(); // 这次没内容（如没连上），继续显示上一次的记录
  renderRecord();
}

async function copyRecord(part: "all" | "target", btn: HTMLButtonElement) {
  if (!record) return;
  const ok = await copyText(formatRecord(record, part));
  const label = btn.textContent;
  btn.textContent = ok ? "已复制 ✓" : "复制失败";
  setTimeout(() => (btn.textContent = label), 1500);
}
$<HTMLButtonElement>("rec-copy-all").addEventListener("click", (e) => copyRecord("all", e.currentTarget as HTMLButtonElement));
$<HTMLButtonElement>("rec-copy-zh").addEventListener("click", (e) => copyRecord("target", e.currentTarget as HTMLButtonElement));
$("rec-download").addEventListener("click", () => record && downloadText(fileName(record), formatRecord(record)));
$("rec-clear").addEventListener("click", () => {
  if (phase !== "idle") return;
  clearRecord();
  record = null;
  renderRecord();
});

// ---------- 本机记忆（失败不影响使用） ----------
const store = {
  get(k: string) {
    try {
      return localStorage.getItem(`lt_${k}`) ?? "";
    } catch {
      return "";
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(`lt_${k}`, v);
    } catch {
      /* 隐私模式等 */
    }
  },
};

const params = new URLSearchParams(location.search);
if (params.get("token")) store.set("token", params.get("token")!);
const srcUrl = params.get("src") ?? undefined;

ui.processing.checked = store.get("processing") === "1";
const savedMode = store.get("mode");
if (savedMode) document.querySelector<HTMLInputElement>(`input[name=mode][value="${savedMode}"]`)?.click();

// ---------- 小工具 ----------
type Light = "off" | "busy" | "ok" | "bad";
function setLight(id: "mic" | "net" | "play", state: Light) {
  $(`light-${id}`).dataset.state = state;
}
function log(line: string) {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  ui.log.textContent = `${t}  ${line}\n${ui.log.textContent}`.slice(0, 8000);
}
function notify(text: string, kind: "info" | "warn" | "error" = "info") {
  ui.notice.hidden = !text;
  ui.notice.textContent = text;
  ui.notice.dataset.kind = kind;
}
function selectedMode(): Mode {
  return (document.querySelector<HTMLInputElement>("input[name=mode]:checked")?.value ?? "audio") as Mode;
}
function wsUrl() {
  const url = new URL("ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  const token = store.get("token");
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

async function refreshMics() {
  try {
    const mics = await listMicrophones();
    const want = store.get("mic");
    ui.mic.replaceChildren(new Option("默认麦克风", ""));
    for (const m of mics) {
      if (!m.deviceId || m.deviceId === "default") continue;
      ui.mic.append(new Option(m.label || `麦克风 ${ui.mic.length}`, m.deviceId, false, m.deviceId === want));
    }
  } catch {
    /* 不支持枚举就用默认 */
  }
}
void refreshMics();
navigator.mediaDevices?.addEventListener?.("devicechange", refreshMics);

// ---------- 屏幕常亮 ----------
let wakeLock: WakeLockSentinel | null = null;
async function keepAwake(on: boolean) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!on) {
      await wakeLock?.release();
      wakeLock = null;
    }
  } catch {
    /* 低电量模式等情况下会被拒绝 */
  }
}

// ---------- 一次同传 ----------
type Phase = "idle" | "starting" | "running" | "finishing";
let phase: Phase = "idle";
let audio: AudioPipeline | null = null;
let ws: WebSocket | null = null;
let sentSec = 0;
let playerBacklog = 0;
let upstreamClosed = false;
let pingTimer: number | undefined;
let pendingAudio: ArrayBuffer[] = [];

function sendAudio(pcm: ArrayBuffer) {
  ws?.send(pcm);
  sentSec += 0.1;
  ui.dSent.textContent = `${sentSec.toFixed(1)} s`;
}

function setPhase(p: Phase) {
  phase = p;
  ui.main.disabled = p === "starting" || p === "finishing";
  ui.main.textContent = { idle: "开始同传", starting: "正在连接…", running: "停止", finishing: "正在收尾…" }[p];
  ui.main.classList.toggle("stop", p === "running");
  ui.setup.toggleAttribute("inert", p !== "idle");
  void keepAwake(p === "running" || p === "finishing");
}

async function start() {
  const mode = selectedMode();
  store.set("mode", mode);
  store.set("processing", ui.processing.checked ? "1" : "0");
  notify("");
  target.clear();
  source.clear();
  record = { startedAt: Date.now(), source: "", target: "" };
  renderRecord();
  ui.subs.hidden = mode === "audio";
  sentSec = 0;
  pendingAudio = [];
  playerBacklog = 0;
  upstreamClosed = false;
  setPhase("starting");

  audio = AudioPipeline.create();
  try {
    await audio.start({
      deviceId: ui.mic.value || undefined,
      processing: ui.processing.checked,
      srcUrl,
      playback: mode !== "text",
      onChunk: (c) => {
        const level = Math.min(1, c.rms * 6);
        ui.meter.style.width = `${Math.round(level * 100)}%`;
        setLight("mic", c.peak > 0.02 ? "ok" : "busy");
        if (phase !== "starting" && phase !== "running") return;
        // 连接建立前的音频先存着（最多约 5 秒），连上后补发，避免开头丢字；后端会缓存到百炼会话就绪
        if (ws?.readyState === WebSocket.OPEN) sendAudio(c.pcm);
        else if (pendingAudio.length < 50) pendingAudio.push(c.pcm);
      },
      onPlayer: (s) => {
        playerBacklog = s.backlog;
        setLight("play", s.playing ? "ok" : "off");
        ui.dBacklog.textContent = `${s.backlog.toFixed(1)} s`;
        ui.dRate.textContent = `${s.rate}×`;
        ui.dDropped.textContent = `${s.dropped.toFixed(1)} s`;
        if (phase === "finishing" && upstreamClosed && s.backlog < 0.05) void finish();
      },
      onSourceEnded: () => {
        log("测试音频播放结束，自动停止");
        stop();
      },
    });
  } catch (err) {
    const e = err as DOMException;
    notify(
      e.name === "NotAllowedError" ? "没有麦克风权限：请在浏览器地址栏或系统设置里允许使用麦克风。" : `无法开始采音：${e.message}`,
      "error",
    );
    setLight("mic", "bad");
    await cleanup();
    return;
  }

  ui.inputLabel.textContent = `当前输入：${audio.inputLabel}`;
  if (audio.deviceId) store.set("mic", audio.deviceId);
  void refreshMics();
  if (looksLikeBluetooth(audio.inputLabel)) {
    notify("正在用蓝牙耳机上的麦克风收音，通常听不清讲台。建议在“麦克风”里改选手机/电脑自带麦克风，或换有线耳机。", "warn");
  }

  setLight("net", "busy");
  ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";
  const send = (m: ClientMessage) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  ws.onopen = () => {
    send({ type: "start", mode });
    for (const pcm of pendingAudio) sendAudio(pcm);
    pendingAudio = [];
    pingTimer = window.setInterval(() => send({ type: "ping", t: performance.now() }), 5000);
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      audio?.play(ev.data);
      return;
    }
    const msg = JSON.parse(ev.data) as ServerMessage;
    switch (msg.type) {
      case "state":
        log(`百炼会话 ${msg.upstream}${msg.detail ? ` ${msg.detail}` : ""}`);
        if (msg.upstream === "ready") {
          setLight("net", "ok");
          setPhase("running");
        } else if (msg.upstream === "closed") {
          upstreamClosed = true;
          target.flush();
          source.flush();
          if (phase === "running") {
            notify("与翻译服务的连接意外断开，请重新开始。", "error");
            setLight("net", "bad");
            void cleanup();
          } else if (mode === "text" || playerBacklog < 0.05) {
            void finish();
          }
        }
        break;
      case "source":
        if (!msg.final) source.push(msg.itemId, msg.text);
        break;
      case "target":
        if (!msg.final) target.push(msg.itemId, msg.text);
        break;
      case "speech":
        log(msg.event === "started" ? "检测到讲话" : "讲话停顿");
        break;
      case "pong":
        ui.dRtt.textContent = `${Math.round(performance.now() - msg.t)} ms`;
        break;
      case "error":
        log(`错误 ${msg.message}`);
        if (msg.code === "busy") {
          notify(msg.message, "warn");
          setLight("net", "bad");
          void cleanup();
        } else if (msg.code === "timeout") {
          notify(msg.message, "warn");
        } else if (phase === "starting") {
          notify(`翻译服务出错：${msg.message}`, "error");
        }
        break;
    }
  };
  ws.onclose = (ev) => {
    clearInterval(pingTimer);
    if (ev.code === 4401) {
      notify("需要访问口令。", "warn");
      ui.tokenBox.hidden = false;
      ui.tokenInput.focus();
      setLight("net", "bad");
      void cleanup();
    } else if (phase === "running" || phase === "starting") {
      notify("网络连接断开了，请检查网络后重新开始。", "error");
      setLight("net", "bad");
      void cleanup();
    }
  };
}

/** 点“停止”：不再上传，等最后一句译完、播完再结束。 */
function stop() {
  if (phase !== "running") return;
  setPhase("finishing");
  audio?.stopInput();
  setLight("mic", "off");
  ui.meter.style.width = "0";
  ws?.send(JSON.stringify({ type: "stop" } satisfies ClientMessage));
  // 兜底：服务端 30 秒没收尾也结束
  window.setTimeout(() => phase === "finishing" && void finish(), 30000);
}

async function finish() {
  if (phase === "idle") return;
  log("本次同传结束");
  await cleanup();
  if (!ui.notice.textContent) notify("已结束。", "info");
}

async function cleanup() {
  finalizeRecord();
  clearInterval(pingTimer);
  const s = ws;
  ws = null;
  if (s && s.readyState <= WebSocket.OPEN) s.close();
  const a = audio;
  audio = null;
  await a?.close().catch(() => {});
  setLight("mic", "off");
  setLight("play", "off");
  if ($("light-net").dataset.state !== "bad") setLight("net", "off");
  ui.meter.style.width = "0";
  setPhase("idle");
}

ui.main.addEventListener("click", () => {
  if (phase === "idle") void start();
  else if (phase === "running") stop();
});

ui.tokenSave.addEventListener("click", () => {
  store.set("token", ui.tokenInput.value.trim());
  ui.tokenBox.hidden = true;
  notify("口令已保存，请点“开始同传”。");
});
ui.tokenInput.addEventListener("keydown", (e) => e.key === "Enter" && ui.tokenSave.click());

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && phase === "running") void keepAwake(true);
  if (document.visibilityState === "hidden" && phase === "running") {
    log("页面切到后台，部分手机会暂停采音");
  }
});
