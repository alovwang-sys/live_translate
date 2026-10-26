// 音频管线：输入（麦克风或测试音频）→ 采音 worklet → 16 kHz PCM 包；译音 PCM → 播放 worklet → 耳机。

import captureUrl from "./capture.worklet.ts?worker&url";
import playerUrl from "./player.worklet.ts?worker&url";

export interface CaptureChunk {
  pcm: ArrayBuffer;
  rms: number;
  peak: number;
}

export interface PlayerStatus {
  backlog: number;
  rate: number;
  playing: boolean;
  dropped: number;
}

export interface AudioOptions {
  deviceId?: string;
  /** 浏览器自带的回声消除 / 降噪 / 自动增益 */
  processing: boolean;
  /** 用这个音频文件代替麦克风（调试用） */
  srcUrl?: string;
  playback: boolean;
  onChunk: (c: CaptureChunk) => void;
  onPlayer: (s: PlayerStatus) => void;
  onSourceEnded?: () => void;
}

export class AudioPipeline {
  readonly ctx = new AudioContext({ latencyHint: "interactive" });
  private stream?: MediaStream;
  private fileSource?: AudioBufferSourceNode;
  private capture?: AudioWorkletNode;
  private player?: AudioWorkletNode;
  /** 实际使用的麦克风名称（测试音频时为文件名） */
  inputLabel = "";

  /** 必须在用户点击的同步调用链里创建，iOS Safari 才允许出声。 */
  static create() {
    const p = new AudioPipeline();
    void p.ctx.resume();
    return p;
  }

  async start(opts: AudioOptions) {
    await Promise.all([this.ctx.audioWorklet.addModule(captureUrl), this.ctx.audioWorklet.addModule(playerUrl)]);

    let input: AudioNode;
    if (opts.srcUrl) {
      const buf = await (await fetch(opts.srcUrl)).arrayBuffer();
      const audio = await this.ctx.decodeAudioData(buf);
      this.fileSource = new AudioBufferSourceNode(this.ctx, { buffer: audio });
      this.fileSource.onended = () => opts.onSourceEnded?.();
      input = this.fileSource;
      this.inputLabel = `测试音频 ${opts.srcUrl.split("/").pop()}`;
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
          channelCount: 1,
          echoCancellation: opts.processing,
          noiseSuppression: opts.processing,
          autoGainControl: opts.processing,
        },
      });
      const track = this.stream.getAudioTracks()[0];
      this.inputLabel = track.label || "默认麦克风";
      input = this.ctx.createMediaStreamSource(this.stream);
    }

    this.capture = new AudioWorkletNode(this.ctx, "capture", { numberOfOutputs: 0 });
    this.capture.port.onmessage = (ev: MessageEvent<CaptureChunk>) => opts.onChunk(ev.data);
    input.connect(this.capture);

    if (opts.playback) {
      this.player = new AudioWorkletNode(this.ctx, "player", { numberOfInputs: 0, outputChannelCount: [2] });
      this.player.port.onmessage = (ev: MessageEvent<PlayerStatus>) => opts.onPlayer(ev.data);
      this.player.connect(this.ctx.destination);
    }

    this.fileSource?.start();
  }

  /** 当前选中麦克风的 deviceId（用于下次默认选中）。 */
  get deviceId() {
    return this.stream?.getAudioTracks()[0]?.getSettings().deviceId;
  }

  play(pcm24k: ArrayBuffer) {
    this.player?.port.postMessage({ type: "pcm", pcm: pcm24k }, [pcm24k]);
  }

  /** 停止采音（译音继续播完）。 */
  stopInput() {
    this.stream?.getTracks().forEach((t) => t.stop());
    try {
      this.fileSource?.stop();
    } catch {
      /* 已停止 */
    }
    this.capture?.disconnect();
    this.capture = undefined;
  }

  async close() {
    this.stopInput();
    this.player?.disconnect();
    await this.ctx.close();
  }
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput");
}

export function looksLikeBluetooth(label: string) {
  return /bluetooth|airpods|buds|hands-?free|蓝牙|headset/i.test(label);
}
