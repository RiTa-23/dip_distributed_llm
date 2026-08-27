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
  const nics = build({ "Wi-Fi": [nic("192.168.11.5")] });

  test("参加者画面のパス(/)まで含めたURLにする", () => {
    expect(buildJoinUrls(nics, "https", 8443)).toEqual(["https://192.168.11.5:8443/"]);
  });

  describe("本番デモ用の公開オリジン(#23)", () => {
    test("設定すると先頭に来る(QRの既定値になる)", () => {
      expect(buildJoinUrls(nics, "https", 8443, "https://llm.example.com:8443")).toEqual([
        "https://llm.example.com:8443/",
        "https://192.168.11.5:8443/",
      ]);
    });

    test("LAN IPの候補は消さない(DNSが死んだときの退避先として残す)", () => {
      const many = build({
        "Wi-Fi": [nic("192.168.11.5")],
        en1: [nic("10.0.0.9")],
      });
      expect(buildJoinUrls(many, "https", 8443, "https://llm.example.com:8443")).toEqual([
        "https://llm.example.com:8443/",
        "https://192.168.11.5:8443/",
        "https://10.0.0.9:8443/",
      ]);
    });

    test("末尾のスラッシュが無くても付ける", () => {
      const [first] = buildJoinUrls(nics, "https", 8443, "https://llm.example.com:8443");
      expect(first).toBe("https://llm.example.com:8443/");
    });

    test("余計なパスやクエリは落としてオリジンだけにする", () => {
      const [first] = buildJoinUrls(nics, "https", 8443, "https://llm.example.com:8443/foo?a=1");
      expect(first).toBe("https://llm.example.com:8443/");
    });

    test("前後の空白は無視する", () => {
      const [first] = buildJoinUrls(nics, "https", 8443, "  https://llm.example.com:8443  ");
      expect(first).toBe("https://llm.example.com:8443/");
    });

    test("ポートは書かれた通りに扱う(8443で配信中なら8443を含めて渡す)", () => {
      const [withPort] = buildJoinUrls(nics, "https", 8443, "https://llm.example.com:8443");
      expect(withPort).toBe("https://llm.example.com:8443/");

      // 省略されていれば省略のまま返す。443以外で配信しているなら呼び出し側の責任で
      // ポートまで含めること(この形はTLSリスナが443のときだけ正しい)
      const withoutPort = buildJoinUrls(nics, "https", 8443, "https://llm.example.com")[0];
      expect(withoutPort).toBe("https://llm.example.com/");
    });

    describe("配信中のスキームと食い違うものは使わない", () => {
      test("TLSで配信中に http:// を渡しても採用しない", () => {
        expect(buildJoinUrls(nics, "https", 8443, "http://llm.example.com:8443")).toEqual([
          "https://192.168.11.5:8443/",
        ]);
      });

      test("HTTP起動中に https:// を渡しても採用しない", () => {
        expect(buildJoinUrls(nics, "http", 3000, "https://llm.example.com:8443")).toEqual([
          "http://192.168.11.5:3000/",
        ]);
      });

      test("HTTP起動中の http:// は採用する", () => {
        expect(buildJoinUrls(nics, "http", 3000, "http://llm.example.com:3000")).toEqual([
          "http://llm.example.com:3000/",
          "http://192.168.11.5:3000/",
        ]);
      });
    });

    describe("使えない値は黙って無視する(書き間違いをQRに載せない)", () => {
      const cases: [string, string | undefined][] = [
        ["未設定", undefined],
        ["空文字", ""],
        ["空白だけ", "   "],
        ["スキームが無い", "llm.example.com:8443"],
        ["相対パス", "/join"],
        ["http(s)以外", "ftp://llm.example.com"],
        ["URLとして壊れている", "https://"],
      ];
      for (const [label, value] of cases) {
        test(label, () => {
          expect(buildJoinUrls(nics, "https", 8443, value)).toEqual(["https://192.168.11.5:8443/"]);
        });
      }
    });

    test("LAN IPが1つも無くても公開オリジンだけは返す", () => {
      const none = build({ lo: [nic("127.0.0.1", { internal: true })] });
      expect(buildJoinUrls(none, "https", 8443, "https://llm.example.com:8443")).toEqual([
        "https://llm.example.com:8443/",
      ]);
    });
  });
});
