import { useState } from "react";
import type { ActionRequest, ActionResult, NextAction } from "../../../src/server/api-types.ts";
import { postJson } from "../lib/api.ts";
import { CommandLine } from "./Commands.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { ChevronRightIcon } from "lucide-react";

/**
 * 人の操作のボタンと入力欄(docs/skeleton.md「フェーズ3」、docs/surface.md の Button・AlertDialog)。
 * どのボタンを出すか・何を送るかはサーバーの nextActions が決め、ここは入力を集めて送るだけ。CLI のコマンドは折りたたんで残す。
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
  const fields = shown
    .flatMap((a) => (a.input && (!compact || a.input.required) ? [a.input] : []))
    .filter((f, i, all) => all.findIndex((g) => g.field === f.field) === i);
  const [values, setValues] = useState<Record<string, string>>({});
  // 送る前に選べるオン/オフ(計画の承認での設計者・デザイナー)。初期値はサーバーが返した値(プランナーの判定)
  const optionActions = compact ? [] : shown.filter((a) => a.options?.length);
  const [choices, setChoices] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(optionActions.flatMap((a) => a.options!.map((o) => [o.key, o.value]))),
  );
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<NextAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 入力が要る操作は、compact では押してから欄を開く
  const [opened, setOpened] = useState(!compact);

  const send = async (a: NextAction) => {
    const text = a.input ? (values[a.input.field] ?? "") : "";
    const design = a.options?.length && !compact ? Object.fromEntries(a.options.map((o) => [o.key, choices[o.key] ?? o.value])) : undefined;
    const body = { ...a.request, ...(a.input ? { [a.input.field]: text } : {}), ...(design ? { design } : {}) } as ActionRequest;
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

  const press = (a: NextAction) => {
    setError(null);
    setMessage(null);
    // compact では、入力が必須の操作だけ欄を開いてから送る(任意のコメントは省いてそのまま送る)
    if (a.input?.required && !opened) return setOpened(true);
    const text = a.input ? (values[a.input.field] ?? "") : "";
    if (a.input?.required && !text.trim()) return setError(`${a.input.placeholder.replace(/[(（].*[)）]/u, "")}を書いてください`);
    if (a.confirm) return setConfirming(a);
    void send(a);
  };

  if (shown.length === 0) return null;
  const withCommand = actions.filter((a) => a.command);
  return (
    <div className="mt-3 flex flex-col gap-2">
      {opened &&
        fields.map((f) => (
          <Textarea
            key={f.field}
            className="bg-card"
            rows={compact ? 2 : 3}
            placeholder={f.placeholder}
            aria-label={f.placeholder}
            value={values[f.field] ?? ""}
            onChange={(e) => setValues({ ...values, [f.field]: e.target.value })}
            disabled={busy}
          />
        ))}
      {optionActions.map((a) => (
        <fieldset key={a.kind} className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1 text-xs text-muted-foreground">承認したあと、実装の前に動かす役割</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {a.options!.map((o) => (
              <label key={o.key} className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  className="accent-foreground"
                  checked={choices[o.key] ?? o.value}
                  onChange={(e) => setChoices({ ...choices, [o.key]: e.target.checked })}
                  disabled={busy}
                />
                {o.label}
              </label>
            ))}
          </div>
          {a.optionsNote && <p className="m-0 text-xs text-muted-foreground">{a.optionsNote}</p>}
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {shown.map((a) => (
          <Button
            key={a.kind}
            type="button"
            size="sm"
            variant={a.primary && !compact ? "default" : a.confirm ? "destructive-outline" : "outline"}
            disabled={busy}
            onClick={() => press(a)}
          >
            {a.input?.required && !opened ? `${a.label}…` : a.label}
          </Button>
        ))}
        {busy && <span className="text-xs text-muted-foreground">送信中…</span>}
      </div>
      {error && (
        <p className="m-0 text-xs whitespace-pre-wrap text-destructive" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="m-0 text-xs text-run" role="status">
          {message}
        </p>
      )}
      {!compact && withCommand.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
            CLI で操作する
          </CollapsibleTrigger>
          <CollapsibleContent forceMount className="mt-2 flex flex-col gap-1.5 data-[state=closed]:hidden">
            {withCommand.map((a) => (
              <CommandLine key={a.command} label={a.label} command={a.command!} copy={false} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
      <AlertDialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.label}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.confirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const a = confirming!;
                setConfirming(null);
                void send(a);
              }}
            >
              {confirming?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
