/**
 * 参加者のブラウザが計算に参加できる状態かを調べる。
 *
 * どの項目も「取れない」ことがある。取れないのと「無い」のは別物なので、
 * boolean ではなく "unknown" を含む3値で持つ。
 * 判定できないものを「使えない」と表示すると、動くPCを追い返すことになる。
 */

export type Support = "yes" | "no" | "unknown";

export type Environment = {
  webgpu: Support;
  /** GB。navigator.deviceMemory は Firefox と Safari では取れない */
  memoryGb: number | null;
  secureContext: boolean;
};

type NavigatorWithGpu = Navigator & {
  gpu?: { requestAdapter: () => Promise<unknown | null> };
  deviceMemory?: number;
};

export const initialEnvironment: Environment = {
  webgpu: "unknown",
  memoryGb: null,
  secureContext: window.isSecureContext,
};

/**
 * requestAdapter() まで呼ぶ。navigator.gpu があってもアダプタが返らない環境
 * (ドライバが古い、GPUが無効化されている等)があり、その場合は実際には動かない。
 */
export async function detectEnvironment(): Promise<Environment> {
  const nav = navigator as NavigatorWithGpu;

  let webgpu: Support = "unknown";
  if (!nav.gpu) {
    webgpu = "no";
  } else {
    try {
      webgpu = (await nav.gpu.requestAdapter()) ? "yes" : "no";
    } catch {
      webgpu = "no";
    }
  }

  return {
    webgpu,
    memoryGb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    secureContext: window.isSecureContext,
  };
}

export function describeWebgpu(s: Support): string {
  if (s === "yes") return "WebGPU 利用可";
  if (s === "no") return "WebGPU 使えません";
  return "WebGPU 確認中";
}

export function describeMemory(gb: number | null): string {
  return gb === null ? "空きメモリ 不明" : `空きメモリ ${gb} GB`;
}
