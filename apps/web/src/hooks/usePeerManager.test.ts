import { describe, expect, test } from "bun:test";
import { createBridge } from "./usePeerManager";
import { createGenerationOwner } from "../webrtc/generationOwner";
import type { WebrtcPeerManager } from "../webrtc/peerManager";

// 見るのは `createBridge` だけ。Reactに依存しない層なので、偽の実体を注いで
// 「世代交代で本当に別の実体へ移るか」「壊す前に失効させているか」をそのまま確かめられる。
//
// ここが守っているのは B-2 の要:
//   1. 旧Runtimeが握っている実体と、新世代が使う実体が別物であること
//   2. **壊す前に世代を失効させてあること**。`close()` / `detach()` は待機中のrecvを
//      起こす(`peerManager.ts` の `destroy()`)ので、起こされた旧Runtimeは必ず失敗を
//      返してくる。順序を間違えると、正常な再編成が画面のエラーになる
//   3. 退役した実体からの通知が現行世代へ漏れないこと

type FakeManager = WebrtcPeerManager & {
  closed: number;
  attached: string[];
  received: string[];
  detached: string[];
  /** テストから好きなタイミングでエラーを出す */
  emitError: (message: string) => void;
  /** `close()` が呼ばれた瞬間に記録したいことがあれば差し込む */
  onClosing?: () => void;
};

function createFakes(log?: string[]) {
  const made: FakeManager[] = [];
  const createManager = (options: { onError: (message: string) => void }): WebrtcPeerManager => {
    const fake = {
      closed: 0,
      attached: [] as string[],
      received: [] as string[],
      detached: [] as string[],
      emitError: (message: string) => options.onError(message),
      attach(remoteId: string) {
        fake.attached.push(remoteId);
      },
      handleMessage(remoteId: string) {
        fake.received.push(remoteId);
      },
      detach(remoteId: string) {
        log?.push("detach");
        fake.detached.push(remoteId);
      },
      close() {
        log?.push("close");
        fake.closed += 1;
        fake.onClosing?.();
      },
    } as unknown as FakeManager;
    made.push(fake);
    return fake;
  };
  return { made, createManager };
}

const CHANNEL = null as unknown as RTCDataChannel;

describe("壊す前に世代を失効させる(fence の実行順)", () => {
  test("onReset: close() の中から見て、トークンは既に失効している", () => {
    const owner = createGenerationOwner();
    const { createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });
    bridge.setOptions({ fence: () => owner.release() });

    const token = owner.claim(1);
    const closing: { seen: boolean | null } = { seen: null };
    (bridge.manager as FakeManager).onClosing = () => {
      closing.seen = token.isCurrent();
    };

    bridge.handlers.onReset();

    // ここが true だと、close で起こされた旧Runtimeの失敗が素通りしてしまう
    expect(closing.seen).toBe(false);
  });

  test("onClose: close() の中から見て、トークンは既に失効している", () => {
    const owner = createGenerationOwner();
    const { createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });
    bridge.setOptions({ fence: () => owner.release() });

    const token = owner.claim(1);
    const closing: { seen: boolean | null } = { seen: null };
    (bridge.manager as FakeManager).onClosing = () => {
      closing.seen = token.isCurrent();
    };

    bridge.handlers.onClose("peer-a");

    expect(closing.seen).toBe(false);
  });

  test("close() の unmount 経路でも fence が先に走る", () => {
    const owner = createGenerationOwner();
    const { createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });
    bridge.setOptions({ fence: () => owner.release() });

    const token = owner.claim(1);
    const closing: { seen: boolean | null } = { seen: null };
    (bridge.manager as FakeManager).onClosing = () => {
      closing.seen = token.isCurrent();
    };

    bridge.close();

    expect(closing.seen).toBe(false);
  });

  test("呼び出し順は fence → close", () => {
    const log: string[] = [];
    const { createManager } = createFakes(log);
    const bridge = createBridge({ isolateGenerations: true, createManager });
    bridge.setOptions({ fence: () => log.push("fence") });

    bridge.handlers.onReset();

    expect(log).toEqual(["fence", "close"]);
  });

  test("fence を預けていなくても落ちない(peer側は渡さない)", () => {
    const log: string[] = [];
    const { createManager } = createFakes(log);
    const bridge = createBridge({ createManager });

    bridge.handlers.onClose("peer-a");
    bridge.handlers.onReset();

    expect(log).toEqual(["detach", "close"]);
  });

  test("onClose から戻った後もトークンは失効したまま(遅れた finally は落ちる)", () => {
    // `requesterSession` の first-fatal は onClose の**後**に onFailed を上げ、画面が
    // そこで生成まわりを初期化する(drain)。その初期化を、あとから解決した旧 run の
    // `.finally` が上書きしないことを保証しているのがこの順序。
    const owner = createGenerationOwner();
    const { createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });
    bridge.setOptions({ fence: () => owner.release() });

    const token = owner.claim(1);
    let lateWrites = 0;
    const lateFinally = token.guard(() => {
      lateWrites += 1;
    });

    bridge.handlers.onClose("peer-a");

    // 戻った時点で失効済み。drain はこの後に走るので、上書きされる余地がない
    expect(token.isCurrent()).toBe(false);
    lateFinally();
    expect(lateWrites).toBe(0);
  });
});

describe("requester: DataChannelを1本失ったら世代ごと畳む", () => {
  test("onClose で旧実体を閉じ、新しい実体へ移る", () => {
    const { made, createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });

    const first = bridge.manager as FakeManager;
    bridge.handlers.onOpen("peer-a", CHANNEL);
    bridge.handlers.onOpen("peer-b", CHANNEL);

    bridge.handlers.onClose("peer-a");

    // detach だけだと peer-b のlinkが旧実体に残り、まだ止まっていない旧Runtimeが
    // そこへ send/recv/connect できてしまう。全部畳むのが正しい
    expect(first.closed).toBe(1);
    expect(first.detached).toEqual([]);
    expect(bridge.manager).not.toBe(first);
    expect(made).toHaveLength(2);
  });

  test("畳んだ後、残っていた相手への作用は新実体にだけ届く", () => {
    const { createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });

    const first = bridge.manager as FakeManager;
    bridge.handlers.onOpen("peer-a", CHANNEL);
    bridge.handlers.onOpen("peer-b", CHANNEL);
    const attachedBefore = [...first.attached];

    bridge.handlers.onClose("peer-a");
    const second = bridge.manager as FakeManager;

    bridge.handlers.onOpen("peer-b", CHANNEL);
    bridge.handlers.onData("peer-b", new Uint8Array([1]));

    expect(second.attached).toEqual(["peer-b"]);
    expect(second.received).toEqual(["peer-b"]);
    // 旧実体の記録は増えない
    expect(first.attached).toEqual(attachedBefore);
    expect(first.received).toEqual([]);
  });

  test("旧Runtimeが握っている実体を叩いても、新世代は汚れない", () => {
    const { createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });

    const heldByOldRuntime = bridge.manager as FakeManager;
    bridge.handlers.onReset();
    const current = bridge.manager as FakeManager;

    heldByOldRuntime.attach("stale-peer", CHANNEL);
    heldByOldRuntime.handleMessage("stale-peer", new Uint8Array([9]));

    expect(current.attached).toEqual([]);
    expect(current.received).toEqual([]);
  });

  test("世代交代を重ねても、毎回新しい実体になる", () => {
    const { made, createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });

    bridge.handlers.onReset();
    bridge.handlers.onReset();

    expect(made).toHaveLength(3);
    expect(made[0]?.closed).toBe(1);
    expect(made[1]?.closed).toBe(1);
    expect(made[2]?.closed).toBe(0); // 現行はまだ生きている
    expect(bridge.manager).toBe(made[2]);
  });

  test("入れ替わりを購読できる(フックの再描画に使う)", () => {
    const { createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });

    let notified = 0;
    const unsubscribe = bridge.subscribe(() => {
      notified += 1;
    });

    bridge.handlers.onReset();
    expect(notified).toBe(1);

    unsubscribe();
    bridge.handlers.onReset();
    expect(notified).toBe(1);
  });
});

describe("エラー転送は現行の実体だけ", () => {
  test("現行の実体のエラーは届く(配線そのものの回帰)", () => {
    // B-2の書き換えで、manager へ `onError` を配線し忘れた退行があった。
    // 落とすと PeerManager の異常が画面にもサーバにも一切伝わらなくなる(#79 も死ぬ)
    const { createManager } = createFakes();
    const bridge = createBridge({ createManager });
    const seen: string[] = [];
    bridge.setOptions({ onError: (message) => seen.push(message) });

    (bridge.manager as FakeManager).emitError("回線が壊れました");

    expect(seen).toEqual(["回線が壊れました"]);
  });

  test("畳んでいる最中の旧実体のエラーは届かない", () => {
    // `close()` は待機中のrecvを起こすので、旧Runtimeはここで必ず悲鳴を上げる。
    // 通してしまうと、正常な再編成が画面のエラーになる
    const { createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });
    const seen: string[] = [];
    bridge.setOptions({ onError: (message) => seen.push(message) });

    const first = bridge.manager as FakeManager;
    first.onClosing = () => first.emitError("閉じられて起こされた");

    bridge.handlers.onReset();

    expect(seen).toEqual([]);
  });

  test("入れ替わった後、旧実体の遅れたエラーは届かない", () => {
    const { createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });
    const seen: string[] = [];
    bridge.setOptions({ onError: (message) => seen.push(message) });

    const first = bridge.manager as FakeManager;
    bridge.handlers.onReset();
    first.emitError("遅れて届いた旧世代のぶん");

    expect(seen).toEqual([]);
  });

  test("入れ替わった後、新実体のエラーは届く", () => {
    const { createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });
    const seen: string[] = [];
    bridge.setOptions({ onError: (message) => seen.push(message) });

    bridge.handlers.onReset();
    (bridge.manager as FakeManager).emitError("新世代のぶん");

    expect(seen).toEqual(["新世代のぶん"]);
  });

  test("unmount の close 後は届かない", () => {
    const { createManager } = createFakes();
    const bridge = createBridge({ isolateGenerations: true, createManager });
    const seen: string[] = [];
    bridge.setOptions({ onError: (message) => seen.push(message) });

    const only = bridge.manager as FakeManager;
    bridge.close();
    only.emitError("片付けた後のぶん");

    expect(seen).toEqual([]);
  });
});

describe("peer 既定(long-lived)", () => {
  test("onClose は detach だけ。実体は入れ替えない", () => {
    const { made, createManager } = createFakes();
    const bridge = createBridge({ createManager });

    const only = bridge.manager as FakeManager;
    bridge.handlers.onClose("peer-a");

    expect(only.detached).toEqual(["peer-a"]);
    expect(only.closed).toBe(0);
    expect(bridge.manager).toBe(only);
    expect(made).toHaveLength(1);
  });

  test("onReset は畳むだけで入れ替えない", () => {
    // peer の Runtime は join → leave のあいだ1つ(B-1のlong-lived契約)。
    // ここで実体が入れ替わると、動いているRuntimeが握る実体だけ取り残される
    const { made, createManager } = createFakes();
    const bridge = createBridge({ createManager });

    const only = bridge.manager as FakeManager;
    bridge.handlers.onReset();

    expect(bridge.manager).toBe(only);
    expect(only.closed).toBe(1);
    expect(made).toHaveLength(1);
  });

  test("onReset の後もエラーは届き続ける(退役させない)", () => {
    // 同じ実体を次の世代でも使う。ここで通知を止めると以降永久に届かなくなる
    const { createManager } = createFakes();
    const bridge = createBridge({ createManager });
    const seen: string[] = [];
    bridge.setOptions({ onError: (message) => seen.push(message) });

    bridge.handlers.onReset();
    (bridge.manager as FakeManager).emitError("世代交代のあとのぶん");

    expect(seen).toEqual(["世代交代のあとのぶん"]);
  });

  test("畳んだ後もハンドラは同じ実体を指す", () => {
    const { createManager } = createFakes();
    const bridge = createBridge({ createManager });

    const only = bridge.manager as FakeManager;
    bridge.handlers.onReset();
    bridge.handlers.onOpen("peer-a", CHANNEL);

    expect(only.attached).toEqual(["peer-a"]);
  });
});

describe("StrictMode の setup → cleanup → setup", () => {
  // dev は mount で効果を2回張る。cleanup で退役したまま戻る口が無いと、
  // 以降 PeerManager の onError が永久に捨てられる(#79 が dev で死ぬ)。
  //
  // **戻すのではなく作り直す。** `stop()` は止まった証明にならないので、cleanup の後も
  // 旧Runtimeが生きている可能性がある。退役済みの実体を active に戻すと、それを
  // 握ったままの旧Runtimeも一緒に復活してしまう。
  test("close → activate で別の実体になり、エラーがまた届く", () => {
    const { made, createManager } = createFakes();
    const bridge = createBridge({ createManager });
    const seen: string[] = [];
    bridge.setOptions({ onError: (message) => seen.push(message) });

    const first = bridge.manager as FakeManager;
    first.emitError("最初のぶん");
    expect(seen).toEqual(["最初のぶん"]);

    bridge.close();
    first.emitError("片付けた後のぶん");
    expect(seen).toEqual(["最初のぶん"]); // 届かない

    bridge.activate();
    const second = bridge.manager as FakeManager;

    // **同一ではなく別の実体**。旧Runtimeが握るのは first のまま
    expect(second).not.toBe(first);
    expect(made).toHaveLength(2);

    // 退役した first は activate の後も戻らない
    first.emitError("旧実体の遅れたぶん");
    expect(seen).toEqual(["最初のぶん"]);

    // 新しい実体のぶんだけ届く
    second.emitError("作り直した後のぶん");
    expect(seen).toEqual(["最初のぶん", "作り直した後のぶん"]);
  });

  test("active なままの activate は何もしない", () => {
    // 通常の mount(1回目の setup)。ここで作り直すと、StrictMode でない環境でも
    // 無駄に実体が増える
    const { made, createManager } = createFakes();
    const bridge = createBridge({ createManager });

    let notified = 0;
    bridge.subscribe(() => {
      notified += 1;
    });

    const only = bridge.manager;
    bridge.activate();

    expect(bridge.manager).toBe(only);
    expect(made).toHaveLength(1);
    expect(notified).toBe(0);
  });
});
