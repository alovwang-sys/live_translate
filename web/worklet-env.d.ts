// AudioWorkletGlobalScope 的最小类型声明（TS 自带 lib 里没有）。
declare const sampleRate: number;
declare const currentTime: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

declare function registerProcessor(
  name: string,
  ctor: new (options?: any) => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
  },
): void;
