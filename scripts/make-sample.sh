#!/usr/bin/env bash
# 用 macOS 自带 TTS 生成一段英文演讲样本：samples/talk_en.wav（16 kHz 单声道 PCM16）
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p samples
TEXT="Good morning everyone, and thank you for joining us today. [[slnc 600]]
My name is Daniel, and I lead the platform team at our company. [[slnc 600]]
Over the last twelve months, we moved most of our services to the cloud, and reduced our infrastructure cost by about thirty percent. [[slnc 800]]
But today I want to talk about something more important than cost. I want to talk about latency. [[slnc 800]]
When a user taps a button, they expect an answer in less than one second. Every extra hundred milliseconds hurts conversion. [[slnc 800]]
So this year, our goal is simple. We will make every page load twice as fast, and we will measure it every single day. [[slnc 800]]
Thank you. I am happy to take your questions now."
say -v Daniel -r 175 -o samples/talk_en.aiff "$TEXT"
afconvert -f WAVE -d LEI16@16000 -c 1 samples/talk_en.aiff samples/talk_en.wav
rm samples/talk_en.aiff
afinfo samples/talk_en.wav | grep -E "duration|Data format"

# 对照样本：同样内容，句间留 2 秒静音，用来逐句测延迟（输出也能按静音切句对齐）
GAPPED=$(printf '%s' "$TEXT" | sed -E 's/\[\[slnc [0-9]+\]\]/[[slnc 2000]]/g')
say -v Daniel -r 175 -o samples/talk_en_gaps.aiff "$GAPPED"
afconvert -f WAVE -d LEI16@16000 -c 1 samples/talk_en_gaps.aiff samples/talk_en_gaps.wav
rm samples/talk_en_gaps.aiff
afinfo samples/talk_en_gaps.wav | grep -E "duration"
