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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChevronRightIcon } from "lucide-react";

/** 危険の色にする操作(確認を出す操作でも、これ以外は通常の色) */
const DANGER: NextAction["kind"][] = ["stop", "cancel"];

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
  // 計画の承認での「分割して進める」(8-2)
  const [split, setSplit] = useState(false);
  // 引き渡しの承認での、開発のタスクを作るプロジェクト(9a)
  const targetAction = compact ? undefined : shown.find((a) => a.targets);
  // 値は既存のプロジェクト名か、":attach"(企画のプロジェクトにリポジトリを登録)・":new"(新しいプロジェクト)。名前に : は使えないので重ならない
  const [target, setTarget] = useState<string>(targetAction?.targets?.selected ?? (targetAction?.targets?.attachTo ? ":attach" : ""));
  const [repoPath, setRepoPath] = useState("");
  const [newName, setNewName] = useState("");
  const preparing = target === ":attach" || target === ":new";
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<NextAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 入力が要る操作は、compact では押してから欄を開く
  const [opened, setOpened] = useState(!compact);

  const send = async (a: NextAction) => {
    const text = a.input ? (values[a.input.field] ?? "") : "";
    const design = a.options?.length && !compact ? Object.fromEntries(a.options.map((o) => [o.key, choices[o.key] ?? o.value])) : undefined;
    const body = { ...a.request, ...(a.input ? { [a.input.field]: text } : {}), ...(design ? { design } : {}), ...(a.split && split ? { split: true } : {}), ...(a.targets ? targetRequest() : {}) } as ActionRequest;
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

  /** 引き渡し先: 既存のプロジェクトは名前、用意するものはリポジトリのフォルダ(と新しい名前) */
  const targetRequest = () => {
    if (!target) return {};
    if (!preparing) return { targetProject: target };
    return { devProject: { repoPath: repoPath.trim(), ...(target === ":new" ? { name: newName.trim() } : {}) } };
  };

  const press = (a: NextAction) => {
    setError(null);
    setMessage(null);
    if (a.targets && preparing && !repoPath.trim()) return setError("リポジトリのフォルダを書いてください");
    if (a.targets && target === ":new" && !newName.trim()) return setError("新しいプロジェクトの名前を書いてください");
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
          {a.split && (
            <label className="mt-1 inline-flex cursor-pointer items-start gap-1.5 text-xs">
              <input type="checkbox" className="mt-0.5 accent-foreground" checked={split} onChange={(e) => setSplit(e.target.checked)} disabled={busy} />
              <span>
                子タスク {a.split.count} 個に分割して進める({a.split.titles.join(" → ")})
              </span>
            </label>
          )}
        </fieldset>
      ))}
      {targetAction && (
        <label className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">開発のタスクを作るプロジェクト</span>
          <select className="rounded-md border bg-card px-2 py-1 text-xs" value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy} aria-label="開発のタスクを作るプロジェクト">
            <option value="">選んでください</option>
            {targetAction.targets!.projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            {targetAction.targets!.attachTo && <option value=":attach">{targetAction.targets!.attachTo} にリポジトリを登録する</option>}
            <option value=":new">新しいプロジェクトを作る</option>
          </select>
          {targetAction.optionsNote && <span className="basis-full text-muted-foreground">{targetAction.optionsNote}</span>}
        </label>
      )}
      {targetAction && preparing && (
        <div className="flex flex-col gap-1.5 text-xs">
          {target === ":new" && (
            <Input className="max-w-[260px] bg-card text-xs" aria-label="新しいプロジェクトの名前" placeholder="名前(英数字と - _)" value={newName} onChange={(e) => setNewName(e.target.value)} disabled={busy} />
          )}
          <Input className="bg-card font-mono text-xs" aria-label="リポジトリのフォルダ" placeholder="/Users/me/dev/app(絶対パス)" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} disabled={busy} />
          <span className="text-muted-foreground">
            手元のリポジトリか、空のフォルダ(無ければ作って git init します)。GitHub などにリポジトリを作る(作った)なら、先に clone したフォルダを指定してください(空のフォルダから始めると、リモートの main と履歴がつながらず PR を作れません)。登録後、プロジェクト把握担当がプロファイルを作ります。プロジェクトの画面でそれを承認すると開発が始まります
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {shown.map((a) => (
          <Button
            key={a.kind}
            type="button"
            size="sm"
            variant={a.primary && !compact ? "default" : DANGER.includes(a.kind) ? "destructive-outline" : "outline"}
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
              variant={confirming && DANGER.includes(confirming.kind) ? "destructive" : "default"}
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
