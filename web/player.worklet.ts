// 播放：接收 24 kHz PCM16 包，线性插值到声卡采样率播放，并控制积压：
//   积压 > SPEEDUP_AT 秒 → 1.15× 播放，回落到 < SPEEDUP_OFF 秒恢复 1×；
//   积压 > DROP_AT 秒   → 丢掉最旧的音频，只保留最新 KEEP_AFTER_DROP 秒。

const SRC_RATE = 24000;
const SPEEDUP_AT = 3;
const SPEEDUP_OFF = 1.5;
const FAST_RATE = 1.15;
const DROP_AT = 6;
const KEEP_AFTER_DROP = 2;

type Msg = { type: "pcm"; pcm: ArrayBuffer } | { type: "clear" };

class PlayerProcessor extends AudioWorkletProcessor {
  private queue: Float32Array[] = [];
  private queued = 0; // 队列里还没播的样本数（24 kHz）
  private head = 0; // queue[0] 中的读取位置（可为小数）
  private rate = 1;
  private droppedSec = 0;
  private playing = false;
  private lastReport = 0;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<Msg>) => {
      const msg = ev.data;
      if (msg.type === "clear") {
        this.queue = [];
        this.queued = 0;
        this.head = 0;
        return;
      }
      const i16 = new Int16Array(msg.pcm);
      const f = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 0x8000;
      this.queue.push(f);
      this.queued += f.length;
      this.controlBacklog();
    };
  }

  private backlogSec() {
    return (this.queued - this.head) / SRC_RATE;
  }

  private controlBacklog() {
    const b = this.backlogSec();
    if (b > DROP_AT) {
      let drop = Math.floor((b - KEEP_AFTER_DROP) * SRC_RATE);
      this.droppedSec += drop / SRC_RATE;
      while (drop > 0 && this.queue.length) {
        const left = this.queue[0].length - this.head;
        if (drop >= left) {
          drop -= left;
          this.queued -= this.queue[0].length;
          this.queue.shift();
          this.head = 0;
        } else {
          this.head += drop;
          drop = 0;
        }
      }
    }
    const nb = this.backlogSec();
    if (nb > SPEEDUP_AT) this.rate = FAST_RATE;
    else if (nb < SPEEDUP_OFF) this.rate = 1;
  }

  /** 取队列中相对读取位置 offset 处的样本（跨包）。 */
  private sampleAt(offset: number): number {
    let pos = this.head + offset;
    for (const buf of this.queue) {
      if (pos < buf.length) return buf[Math.floor(pos)];
      pos -= buf.length;
    }
    return 0;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const ch0 = out[0];
    const step = (SRC_RATE / sampleRate) * this.rate;
    let wrote = false;
    for (let i = 0; i < ch0.length; i++) {
      if (this.queue.length === 0) {
        ch0[i] = 0;
        continue;
      }
      const frac = this.head - Math.floor(this.head);
      const a = this.sampleAt(0 - frac);
      const b = this.sampleAt(1 - frac);
      ch0[i] = a + (b - a) * frac;
      wrote = true;
      this.head += step;
      while (this.queue.length && this.head >= this.queue[0].length) {
        this.head -= this.queue[0].length;
        this.queued -= this.queue[0].length;
        this.queue.shift();
      }
      if (this.queue.length === 0) this.head = 0;
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    if (wrote) this.controlBacklog();

    if (wrote !== this.playing || currentTime - this.lastReport > 0.25) {
      this.playing = wrote;
      this.lastReport = currentTime;
      this.port.postMessage({ backlog: this.backlogSec(), rate: this.rate, playing: wrote, dropped: this.droppedSec });
    }
    return true;
  }
}

registerProcessor("player", PlayerProcessor);
