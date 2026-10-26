# 实测记录

## M1 · 命令行链路验证（2026-10-26）

- 环境：本机 Mac → 百炼北京（`llm-xwv932pj8rnj30mx`），模型 `qwen3.8-livetranslate-flash-realtime`，音色 Tina
- 样本：`scripts/make-sample.sh` 用 macOS TTS（Daniel，175 词/分）生成的 7 句英文演讲
  - `talk_en.wav`：44.4 s，句间停顿 0.6–0.8 s（接近自然语速）
  - `talk_en_gaps.wav`：52.0 s，句间停顿 2 s
- 命令：`npm run probe -- samples/talk_en.wav [--mode text]`
- 延迟口径：
  - **字幕延迟**：这句原声开始被发出去 → 这句译文的第一个字到达
  - **译音延迟**：这句原声开始被发出去 → 这句译音在耳机里开始播放（按“到达即排队播放”模拟，未加速）
  - 逐句对齐靠 `samples/*.anchors.json` 里的译文关键词

| 样本 | 模式 | 字幕延迟 平均 / 最大 | 译音延迟 平均 / 最大 | 尾部延迟* |
|---|---|---|---|---|
| talk_en | 语音 | 3.41 / 4.50 s | 4.08 / 5.46 s | 5.45 s |
| talk_en | 语音 | 3.62 / 4.89 s | 4.41 / 6.19 s | 6.79 s |
| talk_en | 语音（异常的一次） | 6.41 / 11.15 s | 7.59 / 14.23 s | 14.90 s |
| talk_en | 语音 | — | 4.07 / 5.59 s | 6.18 s |
| talk_en_gaps | 语音 | — | 3.74 / 5.67 s | 5.04 s |
| talk_en | 仅字幕 | 3.50 / 4.73 s | — | — |

\* 尾部延迟：原声结束 → 最后一句译音播完（包含最后一句译音本身的时长）。

其他数据：

- 连接 → 会话就绪：1.7–2.7 s
- 首个译音包：开始发音频后 1.7–2.5 s
- 译音下发速度：实时的 0.89–0.93 倍（下发节奏基本跟着输入走，积压不在服务端堆着）
- 发完 `session.finish` → `session.finished`：1.5–1.7 s，尾句没丢
- 翻译质量：7 句全部译出，专有名词（Daniel → 丹尼尔）、数字（30%、12 个月）都对

### 结论与影响

1. **延迟**：译音平均约 4.1–4.4 s，距离 ≤4 s 的目标还差一点；字幕约 3.5 s，能达标。连续讲话时延迟会随时间慢慢变大（1.8 s 涨到 5–6 s），句间有停顿时能追回来。
2. **偶发的慢响应**：4 次语音测试里有 1 次延迟翻倍（最大 14 s），字幕也一起变慢，说明问题出在服务端。M3 需要做“积压过大就丢掉旧句”，并在调试面板里显示实时延迟。
3. **条目粒度**：`speaker_detection` 下，同一个讲话人连续讲 = 一个条目（一个 `item_id`），原文和译文是一个不断增长的长串。所以字幕不能按条目换行，要按译文里的句号自己切句。
4. **事件字段已确认**：
   - 原文增量 `conversation.item.input_audio_transcription.delta.delta`，最终文本在 `.completed.transcript`
   - 译文增量 `response.audio_transcript.delta.delta`（语音模式）/ `response.text.delta.delta`（仅字幕模式）
   - 译音 `response.audio.delta.delta`（Base64 PCM16 24 kHz，每包约 0.3 s）
   - `speech_started` 带 `audio_start_ms` 和 `speaker_id`，`speech_stopped` 带 `audio_end_ms`
5. **默认目标语种是 `en`**：`session.created` 返回的是 `translation.language: "en"`，必须靠 `session.update` 改成 `zh`（已在代码里处理）。
6. **单会话时长上限**：尚未实测。模型上下文上限是 53,248 token，音频输入 7 token/s，输出 12.5 token/s。如果上下文会一直累积，大约 45 分钟就会满。M3 需要用 60 分钟样本实测。
7. **限流**：RPM 10（每分钟最多建 10 个会话），断线重连和续会话都要遵守，不能频繁重试。

## M0 · 网页连通（2026-10-26）

- `npm run build && npm start`，浏览器打开 `http://localhost:8787` 点「测试连通」
- 结果：后端往返 10 ms；百炼会话 connecting → ready 约 2 s → finishing → closed(1000) ✓
