# AGENTS.md · 网页同传助手（live_translate）

> 给在这个仓库里干活的 AI agent / 开发者看的总说明：做什么、怎么做、做到哪一步、哪些规矩不能破。
> 每完成一个里程碑，更新文末「进度」一节。

## 0. 一句话

用浏览器打开 **https://magictoolse.com/live/**，网页采集现场声音 → 后端转发给阿里云百炼实时同传模型 → 耳机里听中文译音，字幕可选。手机、电脑都能用。默认场景：**英语演讲 → 中文收听**。

```mermaid
flowchart LR
    A["现场讲话 / 扩声音箱"] --> B["浏览器网页采音<br/>（手机或电脑）"]
    B -->|"WebSocket：PCM16 16kHz"| C["Node 后端<br/>（保管密钥 / 转发 / 续会话）"]
    C -->|"WebSocket：百炼 Realtime 协议"| D["百炼 qwen3.8-livetranslate-flash-realtime"]
    D -->|"译音 PCM 24kHz、原文、译文"| C
    C --> B
    B --> E["耳机播放译音"]
    B -.-> F["字幕（可选）"]
```

---

## 1. 已知的基础设施（2026-10-26 核对过）

| 项 | 值 | 状态 |
|---|---|---|
| 服务器 | `112.124.61.7`（阿里云，Alibaba Cloud Linux 3，2 核 / 1.8 GB，Node 24），用户 `root` | 本机 `ssh aliyun-server-2` 免密（密钥 `~/.ssh/id_ed25519_autodrive`） |
| 域名 | `magictoolse.com` | A 记录已指向上面的 IP；HTTPS 已可访问（证书在 `/etc/nginx/ssl/`） |
| 代码仓库 | `https://github.com/alovwang-sys/live_translate.git`，分支 `main` | 空仓库，待首次推送 |
| 百炼业务空间 | `llm-xwv932pj8rnj30mx`（北京） | API Key 可用，已列出模型 |
| 同传模型 | `qwen3.8-livetranslate-flash-realtime`（首选）；备选 `qwen3.5-livetranslate-flash-realtime` | 已在空间里确认存在 |

**服务器上已有其他服务，部署时不要碰：**
- `magictoolse.com` 的 `/` 是 `/var/www/magictoolse/frontend` 下的静态站，`/api/` 转发到 `:8000`（python3.8）。配置在 `/etc/nginx/conf.d/magictoolse.conf`。
- `translate.magictoolse.com` 是另一个翻译服务（`:8765` WebSocket，`:8080` API，Let's Encrypt 证书）。配置在 `/etc/nginx/conf.d/translate.conf`。
- 另有宝塔面板 `:18712`、MySQL `:3306`。
- 本项目只用 `127.0.0.1:8787`，访问入口（新子域名或路径）在 M4 前和用户确认，不改动现有站点。

**密钥规矩（硬性）：**
- API Key、服务器密码只放在 `.env`（本机）和服务器上的 `/opt/live_translate/.env`，**永远不进 git、不进前端代码、不写进本文件**。
- 服务器登录改用 SSH 公钥（`ssh-copy-id root@112.124.61.7`），之后关闭密码登录。
- 这两样凭据曾在聊天里明文出现过，**上线前请在阿里云控制台各轮换一次**。

---

## 2. 百炼实时同传接口要点

来源：[接入指南](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime)。参数以官方文档为准，变动时以文档覆盖本节。

- **地址**：`wss://llm-xwv932pj8rnj30mx.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime`
- **鉴权**：请求头 `Authorization: Bearer $DASHSCOPE_API_KEY`（只能在后端加，浏览器 WebSocket 加不了头，这也是必须要后端的原因之一）
- **音频格式**：输入 PCM16 单声道 **16 kHz**；输出 PCM16 **24 kHz**
- **会话配置** `session.update`（qwen3.8）：
  - `session.translation.language`: `"zh"`（目标语种）
  - `session.output_modalities`: `["text","audio"]`（语音模式）或 `["text"]`（仅字幕，更便宜）
  - `session.voice`: 默认 `Tina`
  - `session.audio.input.turn_detection.type`: 默认 `speaker_detection`
  - `session.translation.corpus.phrases`: 术语/人名映射表（≤1000 条），用于提高专有名词准确度
- **客户端 → 服务端**：`input_audio_buffer.append`（Base64 音频）；结束时 `session.finish`
- **服务端 → 客户端**（需要处理的）：
  - `session.created` / `session.updated` / `session.finished`
  - `input_audio_buffer.speech_started` / `speech_stopped`
  - 原文：`conversation.item.input_audio_transcription.delta` / `.completed`
  - 译文：`response.audio_transcript.delta` / `.done`（文本+音频模式）；`response.text.delta` / `.done`（仅文本模式）
  - 译音：`response.audio.delta`（Base64 PCM）/ `response.audio.done`
  - `response.done`、`error`
- **计费**（北京，已核对）：音频输入 7 token/秒 × 0.04 元/千 token ≈ 1.01 元/小时；音频输出 12.5 token/秒 × 0.16 元/千 token ≈ 7.2 元/小时；文本输出 0.1 元/千 token。语音模式约 **8.2 元/小时**，仅字幕模式约 **1.1 元/小时**（另加少量文本费用）。
- **限流**：RPM 10（每分钟最多建 10 个会话），TPM 100,000。重连和续会话都要遵守，不能频繁重试。
- **上下文**：上限 53,248 token。如果会话里的上下文一直累积，大约 45 分钟就会满。
- **单会话时长上限**：文档未写明，M3 用长样本实测；后端按「到上限前主动续会话」设计。
- **M1 实测确认的行为**（详见 `docs/test-log.md`）：
  - `session.created` 返回的默认目标语种是 `en`，必须用 `session.update` 改成 `zh`。
  - `speaker_detection` 下，同一个讲话人连续讲 = 一个条目，原文和译文是一个不断增长的长串，字幕要按句号自己切句。
  - 增量字段都叫 `delta`；最终文本在 `transcript`（原文的 `.completed`、语音模式译文的 `.done`）或 `text`（仅字幕模式）。
  - 译音每包约 0.3 s；服务端下发速度约为实时的 0.9 倍。

---

### 2.1 纯转写（「仅转写」模式，2026-10-27 新增）

- **模型**：`qwen3-asr-flash-realtime`，和同传用同一个地址 `…/api-ws/v1/realtime?model=qwen3-asr-flash-realtime`、同一套协议。Key 用 `.env` 里的 `ASR_API_KEY`，不填则沿用 `DASHSCOPE_API_KEY`。
- **会话配置**：`session.update` 设 `input_audio_format: "pcm"`、`sample_rate: 16000`、`input_audio_transcription.language`（不填自动识别），`turn_detection: { type: "server_vad", threshold: 0.2, silence_duration_ms: 600 }`。
- **事件**：`conversation.item.input_audio_transcription.text` 是中间结果，当前句预览 = `text + stash`，**整句替换，不是增量**；`...completed.transcript` 是最终结果。一个 item 就是一句话，由服务端 VAD 断句。
- **价格**：0.00033 元/秒，约 1.2 元/小时（北京地域有 10 小时免费额度）；RPM 1200。
- **实测**：英文 7 句全对（标点、数字、人名都对）；中文自动识别为 `zh` 也正确；每句话讲完后约 0.5–1 s 出最终结果。建会话比同传慢（4.5–8.5 s），所以后端就绪前的缓存从 5 s 加大到 15 s。
- **并发**：和同传合计共用 `MAX_SESSIONS=2` 的名额。

## 3. 技术选型

| 部分 | 选择 | 理由 |
|---|---|---|
| 后端 | Node.js 22 + TypeScript，`fastify` + `ws` | 一个进程同时提供静态页和 WebSocket 中转；逻辑主要是转发 |
| 前端 | 原生 TypeScript + Vite，不用框架 | 页面就一屏；核心难点在音频而不是 UI |
| 采音 | `getUserMedia` + `AudioWorklet`，在 worklet 里降采样到 16 kHz PCM16，每 100 ms 一包 | 手机/电脑通用，延迟低 |
| 播放 | `AudioWorklet` 环形缓冲播放 24 kHz PCM | 可精确控制积压、变速、丢旧句 |
| 部署 | 服务器上 `systemd` 跑 Node（`127.0.0.1:8787`），nginx 反代 `/` 与 `/ws`（带 WebSocket Upgrade） | 现有 nginx + 证书直接复用 |
| 不需要 | GPU、数据库、自建模型、Docker（首版） | |

### 目录结构（计划）

```
live_translate/
├── AGENTS.md
├── .env.example          # 字段说明，不含真实值
├── package.json
├── shared/
│   └── protocol.ts       # 浏览器 ⇄ 后端 消息类型、采样率常量
├── server/
│   ├── index.ts          # fastify：静态文件 + /ws + /healthz
│   ├── bailian.ts        # 百炼 Realtime 协议客户端（M1 已完成）
│   ├── asr.ts            # 纯转写：qwen3-asr-flash-realtime 客户端（只出原文）
│   ├── relay.ts          # 浏览器 WS ⇄ 百炼 WS 中转、事件精简（M2）
│   ├── session.ts        # 会话生命周期：续会话、重连、尾句收尾（M3）
│   └── config.ts         # 读取 .env（Node 自带 process.loadEnvFile）
├── scripts/
│   ├── make-sample.sh    # 用 macOS TTS 生成英文测试样本
│   ├── probe.ts          # 命令行链路验证与延迟测量（npm run probe）
│   └── probe-asr.ts      # 纯转写链路验证（npm run probe:asr）
├── samples/              # 测试音频（wav 不进 git）、*.anchors.json 逐句对齐关键词
├── web/
│   ├── index.html
│   ├── main.ts           # 页面状态机：开始 → 同传 → 停止收尾；状态灯、提示、调试信息
│   ├── audio.ts          # 音频管线（麦克风/测试音频 → 采音；译音 → 播放）
│   ├── capture.worklet.ts# 降采样到 16 kHz PCM16，每 100 ms 一包
│   ├── player.worklet.ts # 24 kHz 播放 + 积压控制（>3 s 加速、>6 s 跳过）
│   ├── subtitles.ts      # 按句末标点切句的字幕（保留全文，按讲话段分段）
│   ├── record.ts         # 同传记录：复制全部/复制译文/下载 TXT，本机保存最近一次
│   └── selftest.ts       # 收音自检（M3）
├── deploy/
│   ├── nginx.conf        # magictoolse.com 站点配置片段
│   ├── live_translate.service
│   └── deploy.sh         # 本机一键：build → rsync → 重启
└── docs/
    └── test-log.md       # 验收实测记录
```

### 浏览器 ⇄ 后端 协议（自定义，保持简单）

- 浏览器 → 后端：
  - 文本帧 `{"type":"start","mode":"audio"|"audio+text"|"text","target":"zh","phrases":{...}}`
  - 二进制帧：PCM16 16 kHz 原始数据（不做 Base64，省 33% 流量；后端再转 Base64）
  - 文本帧 `{"type":"stop"}`
- 后端 → 浏览器：
  - 文本帧 `{"type":"source","text","final"}` / `{"type":"target","text","final"}` / `{"type":"state",...}` / `{"type":"error",...}`
  - 二进制帧：译音 PCM16 24 kHz

---

## 4. 用户流程

1. 戴耳机，打开 magictoolse.com，点「开始」，允许麦克风。
2. **收音自检（约 30 秒）**：
   - 显示当前麦克风名（`MediaDeviceInfo.label`）；检测到蓝牙耳机麦克风时提醒。
   - 实时电平表，判断远处讲话音量够不够。
   - 「浏览器降噪开」和「关」（`echoCancellation/noiseSuppression/autoGainControl`）各录 8 秒回放对比，用户选好的那个；记到 `localStorage`。
   - 自检录音只在本地回放，不上传。
3. 选模式：语音 / 语音＋字幕 / 仅字幕 → 开始同传。
4. 听讲时：申请 `navigator.wakeLock` 保持常亮；页面显示 **采音 / 连接 / 播放** 三个状态灯；断线有明确提示并自动恢复。
5. 点「停止」：发 `session.finish`，等 `session.finished` 和译音播完再关闭，不丢尾句。
6. **同传记录**：页面下方的「同传记录」区可「复制全部」（中文译文 + 英文原文，带时间头）、「复制译文」、「下载 TXT」。进行中也能导出；三种模式（包括纯语音）都会记。记录每 3 秒存一次到本机浏览器（localStorage），刷新页面或意外关闭后能找回，下一次开始时被覆盖。后端不存任何内容。

诊断：页面可展开「调试面板」，对照 电平 → 原文 → 译文 → 译音积压，分清是收音问题还是翻译问题。后端默认不保存任何录音。

---

## 5. 关键难点与做法

| 问题 | 做法 |
|---|---|
| 蓝牙耳机抢麦克风 | 自检显示实际设备；提供设备下拉框切换；收音差时建议有线耳机或手机外放麦克风 |
| 浏览器降噪压掉远处人声 | 自检 A/B 对比，记住选择；默认关 `noiseSuppression` 试一次 |
| 译音积压、越来越慢 | 播放器积压 > 3 s 时 1.15× 播放；> 6 s 时丢弃最旧的整句，只播最新；字幕完整保留。M1 实测：连续讲话时译音延迟会从约 2 s 涨到 5–6 s，偶尔服务端变慢时会到 14 s，所以这一条必须做 |
| 单会话时长上限 | 后端在上限前（或收到相关 error 时）新开一个百炼会话，在讲话间隙（`speech_stopped` 之后）切换，旧会话 `session.finish` 收尾 |
| 网络波动 / 断线 | 浏览器端指数退避重连（0.5 s→8 s），重连期间本地缓存最多 10 s 音频后补传；后端到百炼断线同样重连 |
| 手机锁屏 | 首版不支持后台运行；用 Wake Lock 防息屏，页面切后台时提示 |
| iOS Safari | AudioContext 必须在用户点击里 `resume()`；采样率可能是 48 kHz，降采样在 worklet 里做 |

---

## 6. 里程碑

每个里程碑做完都要：本机跑通 → 提交 → 更新「进度」。

- **M0 骨架**：仓库初始化、`.env`、package.json、fastify 起静态页 + `/ws`、push 到 GitHub。
- **M1 打通链路（命令行）**：`scripts/probe.ts` 读一个英文 wav，推给百炼，打印原文/译文、保存译音 wav；测出首包延迟、确认会话时长上限和 error 码。
- **M2 网页同传（本机 localhost）**：采音 worklet、后端中转、播放 worklet、字幕、三个模式、停止收尾。
- **M3 收音自检 + 稳定性**：自检页、设备切换、积压控制、续会话、断线重连、调试面板。
- **M4 上线 magictoolse.com/live/**：systemd + nginx 反代 + `deploy.sh`；手机实测。
- **M5 验收**：按第 7 节跑三项测试，结果写入 `docs/test-log.md`。

### 本机开发

```bash
cp .env.example .env      # 填 DASHSCOPE_API_KEY
npm install
npm run dev               # http://localhost:8787 ，localhost 下麦克风无需 HTTPS
npm run typecheck
./scripts/make-sample.sh  # 生成 samples/talk_en.wav、talk_en_gaps.wav
npm run probe -- samples/talk_en.wav            # 语音模式；加 --mode text 测仅字幕
SERVE_SAMPLES=1 npm start # 打开 http://localhost:8787/?src=samples/talk_en.wav 用测试音频代替麦克风
```

每次 probe 约消耗 0.1 元。

### 部署（已上线 https://magictoolse.com/live/）

日常更新只需要在本机运行：

```bash
./deploy/deploy.sh        # 类型检查 → 构建 → tar 经 ssh 上传到 /opt/live_translate → npm ci → 重启服务 → 检查 healthz
```

服务器上的布局（2026-10-26 首次部署）：

| 项 | 位置 |
|---|---|
| 代码 | `/opt/live_translate`（属主是系统用户 `live_translate`，nologin） |
| 配置和密钥 | `/opt/live_translate/.env`（600 权限；API Key、`ACCESS_TOKEN`）。`deploy.sh` 不会覆盖它 |
| 服务 | `/etc/systemd/system/live_translate.service`（来自 `deploy/live_translate.service`），只监听 `127.0.0.1:8787` |
| nginx | `/etc/nginx/conf.d/magictoolse.conf` 的 443 server 块里，`# API反向代理` 之前插入了 `deploy/nginx-live.conf`（`location /live/` → `127.0.0.1:8787/`，带 WebSocket 升级、3 小时超时） |
| nginx 备份 | `/root/nginx-backup/magictoolse.conf.20261026-210902`（插入前的原文件） |

常用命令：

```bash
ssh aliyun-server-2 'systemctl status live_translate'
ssh aliyun-server-2 'journalctl -u live_translate -f'
ssh aliyun-server-2 'grep ^ACCESS_TOKEN= /opt/live_translate/.env'   # 查看访问口令
```

回滚 nginx：`cp /root/nginx-backup/magictoolse.conf.20261026-210902 /etc/nginx/conf.d/magictoolse.conf && nginx -t && systemctl reload nginx`。

---

## 7. 验收标准

| 测试 | 内容 | 通过标准 |
|---|---|---|
| 收音自检 | 现场录音或真实场地 | 识别出的原文基本完整 |
| 短时同传 | 5–10 分钟 | 讲话到听到译音 ≤ 4 秒；漏句很少 |
| 持续运行 | 30–60 分钟 | 延迟不随时间增长；中断 ≤ 1 次且 10 秒内自动恢复 |

交付：源码、启动/部署说明、手机访问方法、`docs/test-log.md` 实测记录（延迟、漏句、中断）。

## 8. 首版不做

火山引擎切换、PPT 图像识别、锁屏后台运行、多人共享收听、用户账号体系。

> 网站公开后任何人都能用，费用记在这个账号上。已做的防护：访问口令 `ACCESS_TOKEN`（网址带一次 `?token=…`，浏览器会记住）、同时使用人数上限 `MAX_SESSIONS=2`（第 3 个人会看到“已满，请稍后再试”）、单次时长上限 `MAX_SESSION_MINUTES=120`。

---

## 9. 代码约定

- TypeScript strict；前后端共用 `shared/protocol.ts` 定义消息类型。
- 不打印 API Key；日志只记事件类型、时延、字节数，不记音频和全文（调试开关除外）。
- 提交信息用中文或英文都行，一次提交做一件事。

## 10. 待确认

1. ~~翻译方向~~：已确认固定「英 → 中」（2026-10-26）。
2. ~~访问口令~~：要（2026-10-26）。
3. 有没有 5–10 分钟现场录音、术语/讲者名单可以提供？
4. ~~M4 访问入口~~：挂在 **`https://magictoolse.com/live/`**（2026-10-26，选了最简单的方式：不加 DNS、不换证书）。nginx 在现有 `magictoolse.conf` 的 443 server 块里加 `location /live/`，转发到 `127.0.0.1:8787/`（去掉前缀）；前端用相对路径，`/ws` 自动变成 `/live/ws`。
5. ~~并发~~：最多 2 人同时使用（2026-10-26）。

## 进度

- [x] 2026-10-26 方案定稿；核对模型名、接口参数；确认域名解析和 HTTPS
- [x] 2026-10-26 M0 骨架：fastify 静态页 + `/ws` + `/healthz`，网页点「测试连通」能走通 浏览器 → 后端 → 百炼会话
- [x] 2026-10-26 M1 打通链路：`npm run probe` 跑通语音和仅字幕两种模式；译音延迟平均约 4.1–4.4 s，字幕约 3.5 s（见 `docs/test-log.md`）
- [x] 2026-10-26 M2 网页同传：采音/播放 worklet、三种模式、中文字幕按句切分、停止时等尾句、访问口令、2 路并发上限；用测试音频在浏览器里端到端验证通过（真实麦克风待用户实测）
- [x] 2026-10-27 纯转写模式「仅转写」：qwen3-asr-flash-realtime，可选语种（自动/英/中/粤/日/韩），记录导出为「转写记录」；原有三种同传模式回归通过
- [x] 2026-10-26 同传记录导出：复制全部 / 复制译文 / 下载 TXT（UTF-8 带 BOM），本机保存最近一次记录
- [ ] M3 自检与稳定性
- [x] 2026-10-26 M4 上线 https://magictoolse.com/live/ ：systemd 服务、nginx `/live/` 反代、访问口令；线上 wss 端到端验证通过（手机真机待用户实测）
- [ ] M5 验收
