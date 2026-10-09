import { useState } from "react";
import type { ActionRequest, ActionResult, NextAction } from "../../../src/server/api-types.ts";
import { postJson } from "../lib/api.ts";

/**
 * 人の操作のボタンと入力欄(docs/skeleton.md「フェーズ3」)。どのボタンを出すか・何を送るかはサーバーの nextActions が決め、
 * ここは入力を集めて送るだけ。CLI のコマンドは折りたたんで残す。
 * - compact: ダッシュボードの対応待ち向けの簡易表示(渡すのは主な操作だけ。CLI のコマンドは出さない)
 */
export function ActionPanel({
  taskId,
  actions,
  onDone,
  compact = false,
}: {
  taskId: number;
  actions: NextAction[];
  onDone?: (r: ActionResult) => void;
  compact?: boolean;
}) {
  const shown = actions.filter((a) => a.request !== null);
  // 同じ欄(承認のコメントと却下の理由など)は1つにまとめ、最初の操作の案内を出す
  const fields = shown.flatMap((a) => (a.input && (!compact || a.input.required) ? [a.input] : [])).filter((f, i, all) => all.findIndex((g) => g.field === f.field) === i);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 入力が要る操作は、compact では押してから欄を開く
  const [opened, setOpened] = useState(!compact);

  const run = async (a: NextAction) => {
    setError(null);
    setMessage(null);
    // compact では、入力が必須の操作だけ欄を開いてから送る(任意のコメントは省いてそのまま送る)
    if (a.input?.required && !opened) return setOpened(true);
    const text = a.input ? (values[a.input.field] ?? "") : "";
    if (a.input?.required && !text.trim()) return setError(`${a.input.placeholder.replace(/[(\uFF08].*[)\uFF09]/u, "")}を書いてください`);
    if (a.confirm && confirming !== a.kind) return setConfirming(a.kind);
    setConfirming(null);
    const body = { ...a.request, ...(a.input ? { [a.input.field]: text } : {}) } as ActionRequest;
    setBusy(true);
    try {
      const r = await postJson<ActionResult>(`/api/tasks/${taskId}/actions`, body);
      setMessage(r.message);
      setValues({});
      onDone?.(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (shown.length === 0) return null;
  const withCommand = actions.filter((a) => a.command);
  return (
    <div className="actions">
      {opened &&
        fields.map((f) => (
          <textarea
            key={f.field}
            className="textarea"
            rows={compact ? 2 : 3}
            placeholder={f.placeholder}
            aria-label={f.placeholder}
            value={values[f.field] ?? ""}
            onChange={(e) => setValues({ ...values, [f.field]: e.target.value })}
            disabled={busy}
          />
        ))}
      <div className="actions__buttons">
        {shown.map((a) =>
          confirming === a.kind ? (
            <span key={a.kind} className="actions__confirm">
              <span className="sm">{a.confirm}</span>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => run(a)}>
                本当に{a.label}
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(null)}>
                やめる
              </button>
            </span>
          ) : (
            <button
              key={a.kind}
              type="button"
              className={`btn ${a.primary ? "btn--primary" : a.confirm ? "btn--danger-outline" : ""}`}
              disabled={busy}
              onClick={() => run(a)}
            >
              {a.input?.required && !opened ? `${a.label}…` : a.label}
            </button>
          ),
        )}
        {busy && <span className="sm muted">送信中…</span>}
      </div>
      {error && (
        <p className="actions__error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="actions__ok" role="status">
          {message}
        </p>
      )}
      {!compact && withCommand.length > 0 && (
        <details className="actions__cli">
          <summary>CLI で操作する</summary>
          <div className="cmds">
            {withCommand.map((a) => (
              <div className="cmd" key={a.command}>
                <span className="cmd__label">{a.label}</span>
                <span className="cmd__code">
                  <code>{a.command}</code>
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
