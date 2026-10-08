import { useState } from "react";
import type { NextAction } from "../../../src/server/api-types.ts";

/** 人が次に打つ CLI コマンド(F9)。フェーズ3でボタンに置き換える */
export function Commands({ actions, showLabel = true }: { actions: NextAction[]; showLabel?: boolean }) {
  if (actions.length === 0) return null;
  return (
    <div className="cmds">
      {actions.map((a) => (
        <div className="cmd" key={a.command}>
          {showLabel && <span className="cmd__label">{a.label}</span>}
          <span className="cmd__code">
            <code>{a.command}</code>
            <CopyButton text={a.command} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1200);
    } catch {
      // クリップボードが使えない環境では何もしない(コマンドは選択してコピーできる)
    }
  };
  return (
    <button type="button" className={`copy ${done ? "copy--done" : ""}`} onClick={copy} aria-label="コマンドをコピー">
      {done ? "コピーしました" : "コピー"}
    </button>
  );
}
