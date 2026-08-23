import { useEffect, useState } from "react";
import { detectEnvironment, initialEnvironment, type Environment } from "../lib/environment";

/**
 * 参加できる環境かを1度だけ調べる。
 * WebGPUの判定に await が要るので、描画を止めないよう後から差し替える形にする。
 */
export function useEnvironment(): Environment {
  const [env, setEnv] = useState<Environment>(initialEnvironment);

  useEffect(() => {
    let alive = true;
    detectEnvironment().then((e) => {
      if (alive) setEnv(e);
    });
    return () => {
      alive = false;
    };
  }, []);

  return env;
}
