import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 見出しつきの区画(Card の簡易版。罫線だけで影なし)。docs/surface.md の Card */
export function Panel({ title, count, attention, actions, children, className, id }: {
  title: ReactNode;
  count?: ReactNode;
  attention?: boolean;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={cn("flex min-h-0 flex-col rounded-lg border bg-card", className)} aria-labelledby={id}>
      <div className="flex items-center gap-2 border-b px-4 py-3 max-sm:px-3">
        <h2 className="m-0 text-sm font-semibold" id={id}>
          {title}
        </h2>
        {count !== undefined && (
          <span className={cn("rounded-full px-1.5 text-[11px] font-semibold", attention ? "bg-attn-soft text-attn" : "bg-muted text-muted-foreground")}>{count}</span>
        )}
        {actions && <span className="ml-auto">{actions}</span>}
      </div>
      {children}
    </section>
  );
}

/** 画面の中の見出し(カードの外) */
export function SectionHead({ title, note }: { title: ReactNode; note?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
      {note !== undefined && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}
