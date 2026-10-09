import type { Attention, TaskSummary } from "../../../../src/server/api-types.ts";
import { paths } from "../../lib/routes.ts";
import { Link } from "../../lib/router.tsx";
import { ActionPanel } from "../ActionPanel.tsx";
import { Commands } from "../Commands.tsx";
import { Panel } from "../Panel.tsx";
import { StateBadge } from "../StateBadge.tsx";
import { Empty } from "../Status.tsx";

/** 対応待ち(F1)。順番は「回答待ち → 承認待ち(計画・デザイン・最終) → 失敗 → 人が作業中」、同じ種類は古い順(長く待たせているもの)から */
const ORDER: Attention[] = ["answer", "approve_plan", "approve_design", "approve_final", "failed", "human_working"];

export function AttentionPanel({ tasks, onDone, operable = true }: { tasks: TaskSummary[]; onDone?: () => void; operable?: boolean }) {
  const list = tasks
    .filter((t) => t.attention)
    .sort((a, b) => ORDER.indexOf(a.attention!) - ORDER.indexOf(b.attention!) || a.updatedAt.localeCompare(b.updatedAt));
  const waiting = list.filter((t) => t.attention !== "human_working").length;
  return (
    <Panel title="対応待ち" count={waiting} attention={waiting > 0} id="attn-title">
      {list.length === 0 ? (
        <Empty>あなたの対応が必要なタスクはありません</Empty>
      ) : (
        <div>
          {list.map((t) => (
            <article className="border-b px-4 py-3 last:border-b-0 max-sm:px-3" key={t.id}>
              <div className="flex min-w-0 items-center gap-2">
                <StateBadge task={t} />
                <span className="text-xs text-subtle-foreground tabular-nums">#{t.id}</span>
                <Link to={paths.task(t.id)} className="min-w-0 truncate font-semibold no-underline hover:underline">
                  {t.title}
                </Link>
              </div>
              {t.reason && <p className="mt-1.5 mb-0 rounded-md bg-muted px-2.5 py-1.5 text-xs break-words whitespace-pre-wrap">{t.reason}</p>}
              {t.primaryAction &&
                (operable ? (
                  <ActionPanel taskId={t.id} actions={[t.primaryAction]} compact onDone={onDone} />
                ) : (
                  <div className="mt-2">
                    <Commands actions={[t.primaryAction]} />
                  </div>
                ))}
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}
