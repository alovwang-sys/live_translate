import type { ClientMessage, ServerMessage } from "../shared/protocol";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $<HTMLPreElement>("log");
const btn = $<HTMLButtonElement>("btn-test");

type Light = "off" | "busy" | "ok" | "bad";
function setLight(id: "light-ws" | "light-upstream", state: Light) {
  $(id).dataset.state = state;
}

function log(line: string) {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logEl.textContent += `${t}  ${line}\n`;
}

// 访问口令：?token=xxx 首次带上后记在本机
function accessToken(): string {
  const fromUrl = new URLSearchParams(location.search).get("token");
  try {
    if (fromUrl) localStorage.setItem("lt_token", fromUrl);
    return fromUrl ?? localStorage.getItem("lt_token") ?? "";
  } catch {
    return fromUrl ?? "";
  }
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = accessToken();
  return `${proto}//${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

btn.addEventListener("click", () => {
  btn.disabled = true;
  logEl.textContent = "";
  setLight("light-ws", "busy");
  setLight("light-upstream", "off");

  const ws = new WebSocket(wsUrl());
  const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

  ws.onopen = () => {
    setLight("light-ws", "ok");
    log("已连上后端");
    send({ type: "ping", t: performance.now() });
    send({ type: "start", mode: "text" });
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    const msg = JSON.parse(ev.data) as ServerMessage;
    switch (msg.type) {
      case "pong":
        log(`后端往返 ${(performance.now() - msg.t).toFixed(0)} ms`);
        break;
      case "state":
        log(`百炼会话：${msg.upstream}${msg.detail ? `（${msg.detail}）` : ""}`);
        if (msg.upstream === "connecting") setLight("light-upstream", "busy");
        if (msg.upstream === "ready") setLight("light-upstream", "ok");
        if (msg.upstream === "closed") {
          ws.close();
          log("连通测试完成 ✓");
        }
        break;
      case "error":
        setLight("light-upstream", "bad");
        log(`错误：${msg.message}`);
        break;
    }
  };
  ws.onclose = (ev) => {
    if (ev.code === 4401) {
      setLight("light-ws", "bad");
      log("访问口令不正确，请在网址后加 ?token=口令");
    }
    btn.disabled = false;
  };
  ws.onerror = () => {
    setLight("light-ws", "bad");
    log("连不上后端");
  };
});
