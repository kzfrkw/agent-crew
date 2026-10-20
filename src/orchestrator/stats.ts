import type { Db } from "../db/connection.ts";

/**
 * 実際の使用での詰まりの集計(設計メモ v0.26 の 4、26-2)。記録(tasks・runs・events・approvals)から集めるだけで、スキーマは増やさない。
 * 数値は件数と内訳を見る(全タスクの平均は見ない。v0.22 の 3)。止まった理由は、環境・ツールが原因のものと判断が要ったものを分ける。
 * 分類は理由の文面のキーワードによる目安なので、分類ごとに実際の文面も件数つきで出し、人が確かめられるようにする
 */

export type StopCategory = "env" | "judgment" | "output" | "base" | "limit" | "repeated" | "stopped" | "other";

export const STOP_LABELS: Record<StopCategory, string> = {
  env: "環境・ツール",
  judgment: "判断が要った",
  output: "役割の出力の不備",
  base: "main への追従",
  limit: "上限・時間切れ",
  repeated: "同じ理由の繰り返し",
  stopped: "人が止めた",
  other: "その他",
};

/** 環境・ツールが原因のものの目安(通信、サンドボックス、ビルド・テスト・撮影の実行、ブラウザ・シミュレータ、ツールの版) */
const ENV =
  /サンドボックス|sandbox|Operation not permitted|Failed host lookup|SocketException|TLS|pub\.dev|registry\.|ネットワーク|network|通信|終了コード|exit code|撮影でき|Chrome|ブラウザ|起動でき|xcodebuild|simctl|シミュレータ|pod install|SwiftPM|Swift Package|Flutter が[^。]*\d+\.\d+|flutter (?:test|drive|analyze|build)/i;
/** 役割の出力の不備と、決まりの不履行(撮影のテストを書いていない、done なのにコミットが無い)。環境より先に見る */
const OUTPUT = /成果物 \S+ が(?:今回の実行で)?書かれていません|判定が不正|判定[^。]*一致しません|ルーブリック|食い違っ|構造化出力|と判定しましたが、コミットがありません|がありません[((].*決まり/;
const BASE = /ベース\(.*\)が進んで|update-base|base_updated|base_conflict|衝突/;

/** 止まった理由(出来事 needs_input / failed の payload)を分類する。原因の種類(event)が無い古い記録は文面だけで見る */
export function classifyStop(p: { event?: string; reason?: string; verdict?: string }): StopCategory {
  const reason = p.reason ?? "";
  if (p.event === "stopped" || /^人が停止/.test(reason)) return "stopped";
  if (p.event === "repeated_failure" || /同じ理由で/.test(reason)) return "repeated";
  if (p.event === "limit_exceeded" || /上限/.test(reason)) return "limit";
  if (p.event === "base_conflict" || BASE.test(reason)) return "base";
  if (OUTPUT.test(reason)) return "output";
  if (ENV.test(reason)) return "env";
  if (p.event === "verdict" || p.event === "ask_human" || /の判定: (?:need_human|blocked)|問い/.test(reason)) return "judgment";
  return "other";
}

/** 人の介入として数える状態の変化(state_changed の event)と、承認の表から数えるもの */
const INTERVENTIONS: Record<string, string> = {
  answer: "回答して再開",
  takeover: "引き取り(人が作業)",
  return: "エージェントに戻す",
  retry: "失敗からやり直し",
  cancel: "取り消し",
  skip_design_review: "デザインレビューを飛ばす",
  back_to_implementer: "実装者に差し戻す",
  reject: "却下",
  approve_comment: "コメントつきの承認",
};
const HUMAN_GATES = ["plan", "design", "final", "strategy", "scope", "handoff"];

const WAITS: Record<string, string> = {
  waiting_repo: "人のリポジトリの未コミットの変更",
  waiting_overlap: "変更するファイルの重なり",
  quota_wait: "利用枠",
};

type Row = Record<string, unknown>;
type Example = { text: string; count: number };

export type Stats = {
  since: string | null;
  tasks: { total: number; done: number };
  stops: { total: number; byCategory: { category: StopCategory; label: string; count: number; examples: Example[] }[] };
  interventions: { kind: string; label: string; count: number }[];
  bounces: { source: string; count: number }[];
  waits: { kind: string; label: string; count: number }[];
  roles: { role: string; runs: number; costUsd: number; durationSec: number }[];
  weeks: { week: string; runs: number; costUsd: number }[];
  bySize: { size: string; tasks: number; medianMinutes: number; medianCostUsd: number }[];
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const seconds = (from: unknown, to: unknown) => (typeof from === "string" && typeof to === "string" ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000) : 0);

/** その日を含む週の月曜(UTC。YYYY-MM-DD) */
function weekOf(iso: string): string {
  const d = new Date(iso);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  return monday.toISOString().slice(0, 10);
}

/** 文面の例: 1行目を短くし、(詳細: …) を除く。数字を除いたものでまとめる */
function exampleOf(reason: string): { key: string; text: string } {
  const text = reason.split("\n")[0]!.replace(/(詳細: [^)]*)/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
  return { key: text.replace(/\d+/g, "N"), text };
}

export function collectStats(db: Db, o: { projectId?: number; since?: string }): Stats {
  const since = o.since ?? "";
  const taskRows = (o.projectId === undefined ? db.prepare("SELECT id, created_at FROM tasks").all() : db.prepare("SELECT id, created_at FROM tasks WHERE project_id = ?").all(o.projectId)) as Row[];
  const taskIds = new Set(taskRows.map((t) => t.id as number));
  const createdAt = new Map(taskRows.map((t) => [t.id as number, t.created_at as string]));
  const mine = (taskId: unknown) => taskIds.has(taskId as number);

  const events = (db.prepare("SELECT task_id, kind, payload, created_at FROM events WHERE task_id IS NOT NULL AND created_at >= ? ORDER BY id").all(since) as Row[])
    .filter((e) => mine(e.task_id))
    .map((e) => ({ taskId: e.task_id as number, kind: e.kind as string, payload: JSON.parse(e.payload as string) as Record<string, unknown>, at: e.created_at as string }));
  const runs = (db.prepare("SELECT task_id, project_id, role, cost_usd, started_at, ended_at FROM runs WHERE started_at >= ?").all(since) as Row[]).filter(
    (r) => mine(r.task_id) || (o.projectId !== undefined ? r.project_id === o.projectId && r.task_id === null : r.task_id === null),
  );
  const approvals = (db.prepare("SELECT task_id, kind, result, comment FROM approvals WHERE created_at >= ?").all(since) as Row[]).filter((a) => mine(a.task_id));

  // 止まった理由
  const groups = new Map<StopCategory, Map<string, Example>>();
  let stopTotal = 0;
  for (const e of events.filter((x) => x.kind === "needs_input" || x.kind === "failed")) {
    stopTotal++;
    const p = e.payload as { event?: string; reason?: string; verdict?: string };
    const cat = classifyStop(p);
    const { key, text } = exampleOf(p.reason ?? "(理由なし)");
    const g = groups.get(cat) ?? new Map<string, Example>();
    const ex = g.get(key) ?? { text, count: 0 };
    ex.count++;
    g.set(key, ex);
    groups.set(cat, g);
  }
  const byCategory = [...groups]
    .map(([category, g]) => ({ category, label: STOP_LABELS[category], count: [...g.values()].reduce((s, x) => s + x.count, 0), examples: [...g.values()].sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count);

  // 人の介入
  const iv = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const e of events.filter((x) => x.kind === "state_changed")) {
    const ev = String(e.payload.event ?? "");
    if (ev in INTERVENTIONS && ev !== "reject") bump(iv, ev);
  }
  for (const a of approvals) {
    if (!HUMAN_GATES.includes(a.kind as string)) continue;
    if (a.result === "rejected") bump(iv, "reject");
    else if (typeof a.comment === "string" && a.comment.trim() && !a.comment.startsWith("自動承認")) bump(iv, "approve_comment");
  }

  const bounces = new Map<string, number>();
  for (const e of events.filter((x) => x.kind === "bounce")) bump(bounces, String(e.payload.source ?? "?"));
  const waits = new Map<string, number>();
  for (const e of events.filter((x) => x.kind in WAITS)) bump(waits, e.kind);

  // 役割ごと・週ごと
  const roles = new Map<string, { runs: number; costUsd: number; durationSec: number }>();
  const weeks = new Map<string, { runs: number; costUsd: number }>();
  for (const r of runs) {
    const x = roles.get(r.role as string) ?? { runs: 0, costUsd: 0, durationSec: 0 };
    x.runs++;
    x.costUsd += (r.cost_usd as number | null) ?? 0;
    x.durationSec += seconds(r.started_at, r.ended_at);
    roles.set(r.role as string, x);
    const w = weeks.get(weekOf(r.started_at as string)) ?? { runs: 0, costUsd: 0 };
    w.runs++;
    w.costUsd += (r.cost_usd as number | null) ?? 0;
    weeks.set(weekOf(r.started_at as string), w);
  }

  // 大きさごとの、期間内に完了したタスク(所要時間は作ってから完了まで、費用はそのタスクの全実行)
  const doneAt = new Map<number, string>();
  for (const e of events) if (e.kind === "state_changed" && e.payload.to === "done") doneAt.set(e.taskId, e.at);
  const sizeOf = new Map<number, string>();
  for (const e of (db.prepare("SELECT task_id, payload FROM events WHERE kind = 'plan' ORDER BY id").all() as Row[]).filter((x) => mine(x.task_id))) {
    sizeOf.set(e.task_id as number, String((JSON.parse(e.payload as string) as { size?: unknown }).size ?? "不明"));
  }
  const costOf = (taskId: number) => ((db.prepare("SELECT SUM(cost_usd) AS c FROM runs WHERE task_id = ?").get(taskId) as { c: number | null }).c ?? 0);
  const sizes = new Map<string, { minutes: number[]; cost: number[] }>();
  for (const [taskId, at] of doneAt) {
    const size = sizeOf.get(taskId) ?? "不明";
    const x = sizes.get(size) ?? { minutes: [], cost: [] };
    x.minutes.push(seconds(createdAt.get(taskId), at) / 60);
    x.cost.push(costOf(taskId));
    sizes.set(size, x);
  }
  const ORDER = ["small", "medium", "large", "不明"];

  return {
    since: o.since ?? null,
    tasks: { total: taskRows.filter((t) => (t.created_at as string) >= since).length, done: doneAt.size },
    stops: { total: stopTotal, byCategory },
    interventions: [...iv].map(([kind, count]) => ({ kind, label: INTERVENTIONS[kind]!, count })).sort((a, b) => b.count - a.count),
    bounces: [...bounces].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    waits: [...waits].map(([kind, count]) => ({ kind, label: WAITS[kind]!, count })).sort((a, b) => b.count - a.count),
    roles: [...roles].map(([role, x]) => ({ role, runs: x.runs, costUsd: round(x.costUsd, 3), durationSec: Math.round(x.durationSec) })).sort((a, b) => b.costUsd - a.costUsd),
    weeks: [...weeks].map(([week, x]) => ({ week, runs: x.runs, costUsd: round(x.costUsd, 3) })).sort((a, b) => a.week.localeCompare(b.week)),
    bySize: [...sizes]
      .map(([size, x]) => ({ size, tasks: x.minutes.length, medianMinutes: round(median(x.minutes), 1), medianCostUsd: round(median(x.cost), 3) }))
      .sort((a, b) => ORDER.indexOf(a.size) - ORDER.indexOf(b.size)),
  };
}

const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)}%` : "-");
const minutes = (sec: number) => (sec >= 60 ? `${Math.round(sec / 60)}分` : `${Math.round(sec)}秒`);

/** 文面にまとめる。notes は人の記録(field-notes)の場所と行数(あれば) */
export function formatStats(s: Stats, o: { projectName?: string; notes?: { path: string; lines: number } | null } = {}): string {
  const out: string[] = [];
  out.push(`集計: ${o.projectName ?? "すべてのプロジェクト"}${s.since ? `(${s.since} から)` : "(全期間)"}  作ったタスク ${s.tasks.total} 件、完了 ${s.tasks.done} 件`);
  out.push("", `■ 止まった理由 ${s.stops.total} 件(分類は文面による目安。例で確かめる)`);
  for (const c of s.stops.byCategory) {
    out.push(`  ${c.label}  ${c.count} 件(${pct(c.count, s.stops.total)})`);
    for (const ex of c.examples.slice(0, 5)) out.push(`      ${ex.count}× ${ex.text}`);
    if (c.examples.length > 5) out.push(`      ほか ${c.examples.length - 5} 種類(--json で全部)`);
  }
  out.push("", "■ 人の介入");
  out.push(...(s.interventions.length ? s.interventions.map((x) => `  ${x.label}  ${x.count}`) : ["  なし"]));
  out.push("", "■ 差し戻し(理由の段)");
  out.push(...(s.bounces.length ? s.bounces.map((x) => `  ${x.source}  ${x.count}`) : ["  なし"]));
  out.push("", "■ 待ち");
  out.push(...(s.waits.length ? s.waits.map((x) => `  ${x.label}  ${x.count}`) : ["  なし"]));
  out.push("", "■ 役割ごとの回数・時間・費用");
  out.push(...(s.roles.length ? s.roles.map((r) => `  ${r.role}  ${r.runs} 回  ${minutes(r.durationSec)}  $${r.costUsd.toFixed(2)}`) : ["  なし"]));
  out.push("", "■ 週ごとの費用(週の初めの月曜)");
  out.push(...(s.weeks.length ? s.weeks.map((w) => `  ${w.week}  ${w.runs} 回  $${w.costUsd.toFixed(2)}`) : ["  なし"]));
  out.push("", "■ 大きさごとの完了したタスク(作ってから完了までの時間(人の待ちを含む)と費用の中央値。件数が少ないうちは目安にしない)");
  out.push(...(s.bySize.length ? s.bySize.map((x) => `  ${x.size}  ${x.tasks} 件  ${x.medianMinutes}分  $${x.medianCostUsd.toFixed(2)}`) : ["  なし"]));
  if (o.notes !== undefined) {
    out.push("", "■ 人の記録");
    out.push(o.notes ? `  ${o.notes.path}(${o.notes.lines} 行)` : "  まだありません。気づいたことを ~/.agent-team/field-notes.md に一言ずつ書いてください(リポジトリには入れない)");
  }
  return out.join("\n");
}
