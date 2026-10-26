// 采音：把麦克风（通常 44.1/48 kHz 浮点）降采样成 16 kHz PCM16，每 100 ms 发一包给主线程。
// 降采样用区间平均（盒式滤波），对语音足够，且不引入额外延迟。

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = TARGET_RATE / 10;

class CaptureProcessor extends AudioWorkletProcessor {
  private ratio = sampleRate / TARGET_RATE;
  private acc = 0; // 当前输出样本已累计的输入和
  private accN = 0; // 已累计的输入样本数（可为小数权重）
  private need = this.ratio; // 当前输出样本还需要的输入样本数
  private out = new Int16Array(CHUNK_SAMPLES);
  private outLen = 0;
  private peak = 0;
  private sumSq = 0;

  process(inputs: Float32Array[][]) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      let x = ch[i];
      let weight = 1;
      // 一个输入样本可能跨两个输出样本，按比例拆分
      while (weight > 0) {
        const take = Math.min(weight, this.need);
        this.acc += x * take;
        this.accN += take;
        this.need -= take;
        weight -= take;
        if (this.need <= 1e-9) this.emit(this.acc / this.accN);
      }
    }
    return true;
  }

  private emit(v: number) {
    this.acc = 0;
    this.accN = 0;
    this.need += this.ratio;
    const s = Math.max(-1, Math.min(1, v));
    this.out[this.outLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    const a = Math.abs(s);
    if (a > this.peak) this.peak = a;
    this.sumSq += s * s;
    if (this.outLen === CHUNK_SAMPLES) {
      const pcm = this.out.buffer;
      this.port.postMessage({ pcm, rms: Math.sqrt(this.sumSq / CHUNK_SAMPLES), peak: this.peak }, [pcm]);
      this.out = new Int16Array(CHUNK_SAMPLES);
      this.outLen = 0;
      this.peak = 0;
      this.sumSq = 0;
    }
  }
}

registerProcessor("capture", CaptureProcessor);
