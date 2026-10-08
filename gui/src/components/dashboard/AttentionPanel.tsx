import type { Attention, TaskSummary } from "../../../../src/server/api-types.ts";
import { paths } from "../../lib/routes.ts";
import { Link } from "../../lib/router.tsx";
import { StateBadge } from "../StateBadge.tsx";
import { Commands } from "../Commands.tsx";

/** 対応待ち(F1)。順番は「回答待ち → 承認待ち → 失敗 → 人が作業中」、同じ種類は古い順(長く待たせているもの)から */
const ORDER: Attention[] = ["answer", "approve_plan", "approve_final", "failed", "human_working"];

export function AttentionPanel({ tasks }: { tasks: TaskSummary[] }) {
  const list = tasks
    .filter((t) => t.attention)
    .sort((a, b) => ORDER.indexOf(a.attention!) - ORDER.indexOf(b.attention!) || a.updatedAt.localeCompare(b.updatedAt));
  const waiting = list.filter((t) => t.attention !== "human_working").length;
  return (
    <section className="card panel" aria-labelledby="attn-title">
      <div className="panel__head">
        <h2 className="panel__title" id="attn-title">
          対応待ち
        </h2>
        <span className={`count-pill ${waiting ? "count-pill--attn" : ""}`}>{waiting}</span>
      </div>
      {list.length === 0 ? (
        <div className="panel__empty">あなたの対応が必要なタスクはありません</div>
      ) : (
        <div>
          {list.map((t) => {
            return (
              <article className="attn-item" key={t.id}>
                <div className="attn-item__top">
                  <StateBadge task={t} />
                  <span className="subtle num sm">#{t.id}</span>
                  <Link to={paths.task(t.id)} className="attn-item__title ellipsis">
                    {t.title}
                  </Link>
                </div>
                {t.reason && <p className="attn-item__reason">{t.reason}</p>}
                {t.primaryAction && <Commands actions={[t.primaryAction]} />}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
