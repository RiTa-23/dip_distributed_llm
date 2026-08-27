import { describe, expect, test } from "bun:test";
import { buildIceConfig, describeIceConfig, IceConfigError, selectIceRoute } from "./iceConfig";

// envの解釈と経路の読み取りだけを見る。Reactにも `import.meta.env` にも依存しない層なので、
// 文字列を流し込んでそのまま確かめられる。
//
// ここが守っているのは3つ:
//   1. **既定は "all"**。relayの強制は検証用で、productionで中継を経由させない
//   2. **中途半端な設定を黙って無効化しない**。「TURNを入れたつもりで効いていない」まま
//      実機検証すると結果を誤読する
//   3. **credentialを外へ出さない**。エラー文にもログ文にも載せない

/** 実credentialに見立てた、他と混ざらない文字列 */
const SECRET = "s3cr3t-must-not-leak";

const FULL = {
  urls: "turn:192.168.1.146:3478?transport=udp,turn:192.168.1.146:3478?transport=tcp",
  username: "dip",
  credential: SECRET,
};

describe("buildIceConfig", () => {
  test("TURNが完全に未設定なら従来どおり(iceServers空 / policy all)", () => {
    for (const env of [{}, { urls: "", username: "", credential: "" }, { urls: "   " }]) {
      const config = buildIceConfig(env);
      expect(config.iceServers).toEqual([]);
      expect(config.iceTransportPolicy).toBe("all");
    }
  });

  test("3項目が揃えばTURNを登録する。既定のpolicyは all", () => {
    const config = buildIceConfig(FULL);

    expect(config.iceServers).toEqual([
      {
        urls: ["turn:192.168.1.146:3478?transport=udp", "turn:192.168.1.146:3478?transport=tcp"],
        username: "dip",
        credential: SECRET,
      },
    ]);
    // productionでrelayを強制しない。host / relay の選択はICEに任せる
    expect(config.iceTransportPolicy).toBe("all");
  });

  test("forceRelay=1 なら policy relay", () => {
    expect(buildIceConfig({ ...FULL, forceRelay: "1" }).iceTransportPolicy).toBe("relay");
  });

  test("forceRelay が 1 以外なら all のまま", () => {
    for (const forceRelay of ["0", "", "true", "yes", undefined]) {
      expect(buildIceConfig({ ...FULL, forceRelay }).iceTransportPolicy).toBe("all");
    }
  });

  test("TURN未設定でforceRelayだけ立てるのは設定エラー", () => {
    // 中継先が無いのにrelayを強制すると必ず繋がらない。黙って all へ倒さない
    expect(() => buildIceConfig({ forceRelay: "1" })).toThrow(IceConfigError);
  });

  test("一部だけ設定されていたら設定エラー(silent disableしない)", () => {
    const partials = [
      { urls: FULL.urls },
      { username: "dip" },
      { credential: SECRET },
      { urls: FULL.urls, username: "dip" },
      { urls: FULL.urls, credential: SECRET },
      { username: "dip", credential: SECRET },
    ];
    for (const env of partials) {
      expect(() => buildIceConfig(env)).toThrow(IceConfigError);
    }
  });

  test("エラー文は欠けている項目名だけを言う", () => {
    try {
      buildIceConfig({ urls: FULL.urls, username: "dip" });
      throw new Error("ここに来てはいけない");
    } catch (e: unknown) {
      const message = (e as Error).message;
      expect(message).toContain("VITE_TURN_CREDENTIAL");
      expect(message).not.toContain("VITE_TURN_URLS");
      expect(message).not.toContain("VITE_TURN_USERNAME");
    }
  });

  test("URLは trim して空要素を捨てる", () => {
    const config = buildIceConfig({ ...FULL, urls: "  turn:a:3478 ,, turn:b:3478  , " });
    expect(config.iceServers?.[0]?.urls).toEqual(["turn:a:3478", "turn:b:3478"]);
  });

  test("turn: / turns: 以外は受け付けない", () => {
    for (const url of ["stun:192.168.1.146:3478", "http://192.168.1.146", "192.168.1.146:3478"]) {
      expect(() => buildIceConfig({ ...FULL, urls: url })).toThrow(IceConfigError);
    }
    expect(() => buildIceConfig({ ...FULL, urls: "turns:192.168.1.146:5349" })).not.toThrow();
  });

  test("混ざっていれば、悪いURLひとつでも弾く", () => {
    expect(() => buildIceConfig({ ...FULL, urls: "turn:a:3478,stun:b:3478" })).toThrow(
      IceConfigError,
    );
  });

  test("credentialはエラー文にもログ文にも出ない", () => {
    // 1つでも漏れると、コンソールやスクリーンショット経由でTURNの資格情報が流出する
    for (const env of [{ urls: FULL.urls, credential: SECRET }, { credential: SECRET }]) {
      try {
        buildIceConfig(env);
        throw new Error("ここに来てはいけない");
      } catch (e: unknown) {
        expect((e as Error).message).not.toContain(SECRET);
      }
    }

    const described = describeIceConfig(buildIceConfig(FULL));
    expect(described).not.toContain(SECRET);
    // usernameも出さない
    expect(described).not.toContain("dip");
  });
});

describe("describeIceConfig", () => {
  test("TURN無しと有りを見分けられる", () => {
    expect(describeIceConfig(buildIceConfig({}))).toContain("TURNなし");

    const described = describeIceConfig(buildIceConfig(FULL));
    expect(described).toContain("turn:192.168.1.146:3478?transport=udp");
    expect(described).toContain("policy=all");
  });

  test("forceRelay のときは policy が分かる", () => {
    expect(describeIceConfig(buildIceConfig({ ...FULL, forceRelay: "1" }))).toContain(
      "policy=relay",
    );
  });
});

/** Chromeの getStats() に近い形をMapで組む */
function statsOf(
  localType: string,
  remoteType: string,
  extra: { protocol?: string; relayProtocol?: string } = {},
): Map<string, unknown> {
  const protocol = extra.protocol ?? "udp";
  return new Map<string, unknown>([
    ["T1", { type: "transport", selectedCandidatePairId: "P1" }],
    [
      "P1",
      {
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "L1",
        remoteCandidateId: "R1",
      },
    ],
    [
      "L1",
      {
        type: "local-candidate",
        candidateType: localType,
        protocol,
        ...(extra.relayProtocol ? { relayProtocol: extra.relayProtocol } : {}),
      },
    ],
    ["R1", { type: "remote-candidate", candidateType: remoteType, protocol }],
  ]);
}

describe("selectIceRoute", () => {
  test("両端relayの経路を読む", () => {
    expect(selectIceRoute(statsOf("relay", "relay", { relayProtocol: "udp" }))).toEqual({
      localType: "relay",
      remoteType: "relay",
      protocol: "udp",
      relayProtocol: "udp",
    });
  });

  test("direct(host / srflx)の経路も読む", () => {
    expect(selectIceRoute(statsOf("host", "host"))).toEqual({
      localType: "host",
      remoteType: "host",
      protocol: "udp",
    });
    expect(selectIceRoute(statsOf("srflx", "host"))?.localType).toBe("srflx");
  });

  test("片側だけrelayの組み合わせも正常として返す", () => {
    // ICEは両端に同じ種類を要求しない。mixedを異常扱いすると、実際に成立している
    // 経路を「読めなかった」と報告してしまう
    expect(selectIceRoute(statsOf("relay", "host", { relayProtocol: "udp" }))).toEqual({
      localType: "relay",
      remoteType: "host",
      protocol: "udp",
      relayProtocol: "udp",
    });
    expect(selectIceRoute(statsOf("host", "relay"))).toEqual({
      localType: "host",
      remoteType: "relay",
      protocol: "udp",
    });
  });

  test("transport が無くても selected / nominated から拾う", () => {
    const selected = statsOf("relay", "relay");
    selected.delete("T1");
    selected.set("P1", {
      type: "candidate-pair",
      selected: true,
      localCandidateId: "L1",
      remoteCandidateId: "R1",
    });
    expect(selectIceRoute(selected)?.localType).toBe("relay");

    const nominated = statsOf("host", "host");
    nominated.delete("T1");
    expect(selectIceRoute(nominated)?.localType).toBe("host");
  });

  test("成立した pair が無ければ null", () => {
    expect(selectIceRoute(new Map())).toBeNull();
    expect(
      selectIceRoute(
        new Map<string, unknown>([
          ["P1", { type: "candidate-pair", state: "in-progress", nominated: false }],
        ]),
      ),
    ).toBeNull();
  });

  test("候補が欠けていても落ちない(nullを返す)", () => {
    const missingLocal = statsOf("relay", "relay");
    missingLocal.delete("L1");
    expect(selectIceRoute(missingLocal)).toBeNull();

    const broken = new Map<string, unknown>([
      ["T1", null],
      ["P1", "candidate-pair"],
    ]);
    expect(selectIceRoute(broken)).toBeNull();
  });

  test("protocol が読めなければ unknown にする(経路自体は報告する)", () => {
    const noProtocol = statsOf("relay", "relay");
    noProtocol.set("L1", { type: "local-candidate", candidateType: "relay" });
    noProtocol.set("R1", { type: "remote-candidate", candidateType: "relay" });
    expect(selectIceRoute(noProtocol)?.protocol).toBe("unknown");
  });
});
