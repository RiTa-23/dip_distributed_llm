import { describe, expect, test } from "bun:test";
import { buildJoinUrls, pickLanAddresses, type NetworkInterfaces } from "./lanAddress";

/** テスト用のNICエントリ。実物の型は項目が多いので、判定に使う分だけ埋める */
function nic(address: string, opts: { internal?: boolean; family?: string } = {}) {
  return {
    address,
    family: opts.family ?? "IPv4",
    internal: opts.internal ?? false,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: `${address}/24`,
  };
}

const build = (entries: Record<string, ReturnType<typeof nic>[]>) => entries as NetworkInterfaces;

describe("pickLanAddresses", () => {
  test("ループバックと非IPv4は除外する", () => {
    const nics = build({
      lo: [nic("127.0.0.1", { internal: true }), nic("::1", { family: "IPv6", internal: true })],
      wlan0: [nic("192.168.1.23"), nic("fe80::1", { family: "IPv6" })],
    });
    expect(pickLanAddresses(nics)).toEqual(["192.168.1.23"]);
  });

  test("リンクローカル(169.254.x)は到達できないので除外する", () => {
    const nics = build({ eth0: [nic("169.254.10.2")], wlan0: [nic("10.0.5.7")] });
    expect(pickLanAddresses(nics)).toEqual(["10.0.5.7"]);
  });

  test("仮想NIC(172.16-31)より会場Wi-Fiらしいアドレスを先に返す", () => {
    const nics = build({
      "vEthernet (WSL)": [nic("172.28.16.1")],
      "Wi-Fi": [nic("192.168.11.5")],
      イーサネット: [nic("10.1.2.3")],
    });
    expect(pickLanAddresses(nics)).toEqual(["192.168.11.5", "10.1.2.3", "172.28.16.1"]);
  });

  test("同じアドレスが複数NICに出ても1つにまとめる", () => {
    const nics = build({ a: [nic("192.168.1.23")], b: [nic("192.168.1.23")] });
    expect(pickLanAddresses(nics)).toEqual(["192.168.1.23"]);
  });

  test("候補が無ければ空配列", () => {
    expect(pickLanAddresses(build({ lo: [nic("127.0.0.1", { internal: true })] }))).toEqual([]);
  });
});

describe("buildJoinUrls", () => {
  test("参加者画面のパス(/)まで含めたURLにする", () => {
    const nics = build({ "Wi-Fi": [nic("192.168.11.5")] });
    expect(buildJoinUrls(nics, "https", 8443)).toEqual(["https://192.168.11.5:8443/"]);
  });
});
