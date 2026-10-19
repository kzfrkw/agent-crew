/**
 * 役割の見せ方(docs/surface.md の「役割のキャラクター」)。日本語の名前、実行中に何をしているか、
 * キャラクターが持つ道具と、実行中の道具の動き。roles/*.md に役割を足したらここにも足す(テストで確かめる)
 */

export type RoleTool =
  | "clipboard"
  | "compass"
  | "pencil"
  | "laptop"
  | "magnifier"
  | "stamp"
  | "checklist"
  | "frame"
  | "merge"
  | "flask"
  | "map"
  | "bulb"
  | "globe"
  | "target"
  | "cards"
  | "wireframe"
  | "box"
  | "bubble"
  | "baton"
  | "book";

/** scan: 左右に動かす(読む・見比べる)、type: 小刻みに上下(打つ)、write: 傾ける(書く)、wave: 大きく振る、stamp: 押す */
export type RoleMotion = "scan" | "type" | "write" | "wave" | "stamp";

export type RoleMeta = { label: string; doing: string; tool: RoleTool; motion: RoleMotion };

export const ROLE_META: Record<string, RoleMeta> = {
  planner: { label: "プランナー", doing: "計画を立てています", tool: "clipboard", motion: "write" },
  architect: { label: "設計者", doing: "設計を考えています", tool: "compass", motion: "write" },
  designer: { label: "デザイナー", doing: "画面の仕様を描いています", tool: "pencil", motion: "write" },
  implementer: { label: "実装者", doing: "コードを書いています", tool: "laptop", motion: "type" },
  reviewer: { label: "レビュワー", doing: "差分を読んでいます", tool: "magnifier", motion: "scan" },
  auditor: { label: "監査担当", doing: "指摘を確かめています", tool: "stamp", motion: "stamp" },
  qa: { label: "QA 担当", doing: "受け入れ条件を確かめています", tool: "checklist", motion: "write" },
  design_reviewer: { label: "デザインレビュー担当", doing: "画面を見比べています", tool: "frame", motion: "scan" },
  integrator: { label: "統合担当", doing: "取り込みの準備をしています", tool: "merge", motion: "wave" },
  verifier: { label: "検証担当", doing: "テストを走らせています", tool: "flask", motion: "type" },
  profiler: { label: "プロジェクト把握担当", doing: "リポジトリを調べています", tool: "map", motion: "scan" },
  retrospective: { label: "振り返り担当", doing: "タスクを振り返っています", tool: "bulb", motion: "wave" },
  researcher: { label: "調査担当", doing: "調べています", tool: "globe", motion: "scan" },
  strategist: { label: "企画担当", doing: "戦略を練っています", tool: "target", motion: "write" },
  product: { label: "要件担当", doing: "要件をまとめています", tool: "cards", motion: "write" },
  ux: { label: "UX 担当", doing: "画面の骨組みを描いています", tool: "wireframe", motion: "write" },
  handoff: { label: "まとめ担当", doing: "チケットにまとめています", tool: "box", motion: "stamp" },
  critic: { label: "批評担当", doing: "成果物を批評しています", tool: "bubble", motion: "wave" },
  coordinator: { label: "コーディネーター", doing: "次の一手を考えています", tool: "baton", motion: "wave" },
  explainer: { label: "解説担当", doing: "変更の解説を書いています", tool: "book", motion: "write" },
};

/** 知らない役割(後から足したもので、ここに無いもの)は名前をそのまま出す */
export function roleMeta(role: string): RoleMeta {
  return ROLE_META[role] ?? { label: role, doing: "作業しています", tool: "clipboard", motion: "write" };
}
