import type { DesignOptions, TaskState } from "../../../src/server/api-types.ts";
import { pipelineOf, type StageStatus } from "../lib/pipeline.ts";
import { cn } from "@/lib/utils";

const STATUS_TEXT: Record<StageStatus, string> = { done: "済み", current: "現在", todo: "未着手", blocked: "人の対応待ち", human: "人が作業中", failed: "失敗", skipped: "このタスクでは飛ばす" };

const STAGE: Record<StageStatus, { text: string; dot: string }> = {
  done: { text: "text-muted-foreground", dot: "border-muted-foreground bg-muted-foreground" },
  current: { text: "font-semibold text-run", dot: "border-run bg-run ring-[3px] ring-run-soft" },
  todo: { text: "text-subtle-foreground", dot: "border-input bg-card" },
  skipped: { text: "text-subtle-foreground line-through decoration-subtle-foreground/60", dot: "border-dashed border-input bg-transparent" },
  blocked: { text: "font-semibold text-attn", dot: "rotate-45 rounded-[2px] border-attn bg-attn ring-[3px] ring-attn-soft" },
  human: { text: "font-semibold text-human", dot: "border-human bg-human ring-[3px] ring-human-soft" },
  failed: { text: "font-semibold text-destructive", dot: "border-destructive bg-destructive ring-[3px] ring-destructive-soft" },
};

/** パイプライン上の位置(docs/surface.md) */
export function Pipeline({ state, heldFrom, design, kind }: { state: TaskState; heldFrom: TaskState | null; design?: DesignOptions; kind?: string }) {
  return (
    <ol className="mt-3 flex flex-wrap items-center text-xs" aria-label="パイプライン">
      {pipelineOf(state, heldFrom, design, kind).map((s, i) => (
        <li
          key={s.state}
          className={cn("flex items-center gap-1.5", STAGE[s.status].text)}
          title={STATUS_TEXT[s.status]}
          aria-label={`${s.label}: ${STATUS_TEXT[s.status]}`}
          aria-current={!["done", "todo", "skipped"].includes(s.status) ? "step" : undefined}
        >
          {i > 0 && <span className="mx-1.5 h-px w-4 bg-input" aria-hidden />}
          <span className={cn("size-[9px] flex-none rounded-full border-[1.5px]", STAGE[s.status].dot)} aria-hidden />
          <span aria-hidden>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}
