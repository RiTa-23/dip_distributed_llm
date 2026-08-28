import { describe, expect, test } from "bun:test";
import {
  buildTurnUrls,
  findTurnConfPath,
  replaceTurnIps,
  replaceTurnUrls,
  TurnConfigError,
  TURN_CONF_CANDIDATES,
} from "./turnConfig";

/** 実物と同じ形の turnserver.conf。**書き換えてはいけない行**を意図的に混ぜてある */
const CONF = `# 会場LAN内TURN
listening-port=3478
listening-ip=192.168.1.43
relay-ip=192.168.1.43

lt-cred-mech
realm=dip.local
user=dip:secret-should-survive

no-tls
min-port=49160
max-port=49200
`;

/** 実物と同じ形の .env.local */
const ENV_LOCAL = `# 会場LAN内TURN
VITE_TURN_URLS=turn:192.168.1.43:3478?transport=udp,turn:192.168.1.43:3478?transport=tcp
VITE_TURN_USERNAME=dip
VITE_TURN_CREDENTIAL=secret-should-survive
VITE_FORCE_RELAY=0
`;

describe("replaceTurnIps", () => {
  test("listening-ip と relay-ip の両方を差し替える", () => {
    const out = replaceTurnIps(CONF, "172.16.8.27");
    expect(out).toContain("listening-ip=172.16.8.27");
    expect(out).toContain("relay-ip=172.16.8.27");
    expect(out).not.toContain("192.168.1.43");
  });

  test("credential と realm を巻き添えにしない", () => {
    // ここが壊れると turnserver.conf と .env.local の対応が崩れ、認証が通らなくなる
    const out = replaceTurnIps(CONF, "10.0.5.22");
    expect(out).toContain("user=dip:secret-should-survive");
    expect(out).toContain("realm=dip.local");
    expect(out).toContain("listening-port=3478");
    expect(out).toContain("min-port=49160");
  });

  test("同じIPで2回流しても結果が変わらない(冪等)", () => {
    const once = replaceTurnIps(CONF, "10.0.5.22");
    expect(replaceTurnIps(once, "10.0.5.22")).toBe(once);
  });

  test("対象行が無ければ追記せずエラー", () => {
    // 想定外のファイルを渡されたときに壊したものを書き出さない
    expect(() => replaceTurnIps("listening-port=3478\n", "10.0.5.22")).toThrow(TurnConfigError);
  });

  test("コメント行は書き換えない", () => {
    // 例示のコメントを書き換えると、実際の設定が古いまま残る
    const conf = `# listening-ip=10.0.0.1 のように書く\nlisting-typo=1\nlistening-ip=192.168.1.43\nrelay-ip=192.168.1.43\n`;
    const out = replaceTurnIps(conf, "172.16.8.27");
    expect(out).toContain("# listening-ip=10.0.0.1 のように書く");
    expect(out).toContain("listening-ip=172.16.8.27");
  });
});

describe("buildTurnUrls", () => {
  test("udp と tcp を必ず両方出す", () => {
    // tcpを落とすと、UDPが遮断されたLANで中継できなくなる
    const urls = buildTurnUrls("172.16.8.27");
    expect(urls).toBe("turn:172.16.8.27:3478?transport=udp,turn:172.16.8.27:3478?transport=tcp");
  });

  test("ポートを変えられる", () => {
    expect(buildTurnUrls("10.0.0.1", 3479)).toContain("turn:10.0.0.1:3479?transport=udp");
  });
});

describe("replaceTurnUrls", () => {
  test("URLだけ差し替え、credentialを保つ", () => {
    const out = replaceTurnUrls(ENV_LOCAL, "172.16.8.27");
    expect(out).toContain("turn:172.16.8.27:3478?transport=udp");
    expect(out).toContain("turn:172.16.8.27:3478?transport=tcp");
    expect(out).toContain("VITE_TURN_CREDENTIAL=secret-should-survive");
    expect(out).toContain("VITE_TURN_USERNAME=dip");
    expect(out).toContain("VITE_FORCE_RELAY=0");
    expect(out).not.toContain("192.168.1.43");
  });

  test("冪等", () => {
    const once = replaceTurnUrls(ENV_LOCAL, "10.0.5.22");
    expect(replaceTurnUrls(once, "10.0.5.22")).toBe(once);
  });

  test("VITE_TURN_URLS が無ければエラー", () => {
    expect(() => replaceTurnUrls("VITE_TURN_USERNAME=dip\n", "10.0.5.22")).toThrow(TurnConfigError);
  });
});

describe("findTurnConfPath", () => {
  const env = {} as Record<string, string | undefined>;

  test("候補を上から探す", () => {
    const exists = (p: string) => p === TURN_CONF_CANDIDATES[1];
    expect(findTurnConfPath(exists, env)).toBe(TURN_CONF_CANDIDATES[1]);
  });

  test("TURN_CONF が最優先", () => {
    const exists = () => true;
    expect(findTurnConfPath(exists, { TURN_CONF: "/tmp/my.conf" })).toBe("/tmp/my.conf");
  });

  test("TURN_CONF が空文字なら無視して候補へ落ちる", () => {
    // 環境変数を空で定義しているだけの状態を「指定なし」として扱う
    const exists = (p: string) => p === TURN_CONF_CANDIDATES[0];
    expect(findTurnConfPath(exists, { TURN_CONF: "  " })).toBe(TURN_CONF_CANDIDATES[0]);
  });

  test("TURN_CONF を指定してもファイルが無ければ候補へ落ちる", () => {
    const exists = (p: string) => p === TURN_CONF_CANDIDATES[0];
    expect(findTurnConfPath(exists, { TURN_CONF: "/nope.conf" })).toBe(TURN_CONF_CANDIDATES[0]);
  });

  test("どこにも無ければ null", () => {
    expect(findTurnConfPath(() => false, env)).toBeNull();
  });
});
