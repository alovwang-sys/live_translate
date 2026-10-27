// 同传记录：导出原文 + 译文全文（复制 / 下载 .txt），并在本机保存最近一次记录，刷新页面也能找回。

export interface TranscriptRecord {
  /** 同传（原文 + 译文）还是纯转写（只有原文）；旧记录没有这个字段，按同传处理 */
  kind?: "translate" | "asr";
  startedAt: number;
  endedAt?: number;
  source: string;
  target: string;
}

const STORE_KEY = "lt_last_record";

export function saveRecord(r: TranscriptRecord) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(r));
  } catch {
    /* 隐私模式或空间不足：不影响当前页面的复制/下载 */
  }
}

export function loadRecord(): TranscriptRecord | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const r = raw ? (JSON.parse(raw) as TranscriptRecord) : null;
    return r && (r.source || r.target) ? r : null;
  } catch {
    return null;
  }
}

export function clearRecord() {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* 忽略 */
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateStr = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const timeStr = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function describe(r: TranscriptRecord) {
  const end = r.endedAt ? `–${timeStr(r.endedAt)}` : "（进行中）";
  const mins = r.endedAt ? `，${Math.max(1, Math.round((r.endedAt - r.startedAt) / 60000))} 分钟` : "";
  return `${dateStr(r.startedAt)} ${timeStr(r.startedAt)}${end}${mins}`;
}

export function formatRecord(r: TranscriptRecord, part: "all" | "target" | "source" = "all") {
  if (r.kind === "asr") {
    if (part !== "all") return r.source;
    return ["网页转写记录", `时间：${describe(r)}`, "", r.source || "（无）", ""].join("\n");
  }
  if (part === "target") return r.target;
  if (part === "source") return r.source;
  return [
    "网页同传记录",
    `时间：${describe(r)}`,
    "方向：英语 → 中文",
    "",
    "==================== 中文译文 ====================",
    "",
    r.target || "（无）",
    "",
    "==================== 英文原文 ====================",
    "",
    r.source || "（无）",
    "",
  ].join("\n");
}

export function fileName(r: TranscriptRecord) {
  return `${r.kind === "asr" ? "转写记录" : "同传记录"}_${dateStr(r.startedAt)}_${timeStr(r.startedAt).replace(":", "")}.txt`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 旧浏览器或非安全上下文的兜底
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function downloadText(name: string, text: string) {
  // 加 BOM，Windows 记事本打开中文不乱码
  const blob = new Blob(["﻿", text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
