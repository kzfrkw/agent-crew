import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { NextAction } from "../../../src/server/api-types.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** CLI のコマンドの表示(F9)。完了後の push のように、GUI から送らない操作に使う */
export function Commands({ actions, showLabel = true }: { actions: NextAction[]; showLabel?: boolean }) {
  const list = actions.flatMap((a) => (a.command === null ? [] : [{ ...a, command: a.command }]));
  if (list.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {list.map((a) => (
        <CommandLine key={a.command} label={showLabel ? a.label : undefined} command={a.command} />
      ))}
    </div>
  );
}

export function CommandLine({ label, command, copy = true }: { label?: string; command: string; copy?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2 max-sm:flex-col max-sm:items-stretch max-sm:gap-0.5">
      {label && <span className="text-xs whitespace-nowrap text-muted-foreground max-sm:whitespace-normal">{label}</span>}
      <span className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-card py-0.5 pr-1 pl-2.5">
        <code className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-[12.5px] whitespace-nowrap before:text-subtle-foreground before:content-['$_'] max-sm:break-all max-sm:whitespace-pre-wrap">
          {command}
        </code>
        {copy && <CopyButton text={command} />}
      </span>
    </div>
  );
}

export function CopyButton({ text, label = "コマンドをコピー", children }: { text: string; label?: string; children?: string }) {
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
    <Button type="button" variant="ghost" size="xs" className={cn("text-muted-foreground", done && "text-run")} onClick={copy} aria-label={label}>
      {done ? <CheckIcon /> : <CopyIcon />}
      {done ? "コピーしました" : (children ?? "コピー")}
    </Button>
  );
}
