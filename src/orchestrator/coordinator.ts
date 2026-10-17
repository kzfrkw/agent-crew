import type { RoleDef } from "../roles/roles.ts";
import { parseVerdict } from "../roles/roles.ts";
import type { HumanApprovalKind } from "./transitions.ts";

/**
 * コーディネーターの一手の検証(設計メモ v0.21、フェーズ10-1)。DB やプロセスに触れない純粋関数。
 * 進め方(次にどの役割を呼ぶか)はコーディネーターが決め、ここは「許される一手か」だけを見る:
 * 役割が存在してタスクの種類で使えるか、人の承認の関門を飛ばしていないか、完了の条件がそろっているか、上限を超えていないか。
 * 許されない一手は必ず却下する(理由を添えてコーディネーターに返し、続けば人に回す)
 */

export type TaskKind = "normal" | "test_infra" | "planning";

/** 検証に使う事実。呼ぶ側が DB と git から集める */
export type CoordinatorFacts = {
  kind: TaskKind;
  /** 失効していない、承認された人の関門 */
  approvals: HumanApprovalKind[];
  /** すべてのリポジトリで、今のコミットのテストの再実行が合格している(ツールが判定したもの) */
  testsPassed: boolean;
  /** 統合が済んでいる(開発のタスク) */
  integrated: boolean;
  /** このタスクで起動した役割の回数(コーディネーター自身を含む) */
  runCount: number;
  /** このタスクの費用の合計 */
  costUsd: number;
};

export type CoordinatorLimits = { maxRunsPerTask: number; maxCostPerTaskUsd: number };

type Base = { summary: string; reason: string; deviatesFromDefault: boolean };
export type CoordinatorMove = Base &
  (
    | { type: "run_role"; role: string; input: string }
    | { type: "ask_human"; question: string }
    | { type: "request_approval"; gate: HumanApprovalKind }
    | { type: "complete" }
    | { type: "fail" }
  );

/** limit は上限に達した(コーディネーターに返さず人に回す)。rejected は理由を添えてコーディネーターに返す */
export type MoveCheck = { ok: true; move: CoordinatorMove } | { ok: false; kind: "rejected" | "limit"; reason: string };

/** タスクの種類ごとに、コーディネーターが呼べる役割。コーディネーター自身、把握担当・振り返り(別の契機で動く)、監査・検証(ツールの内部で動く)は含めない */
const DEV_ROLES = ["planner", "architect", "designer", "implementer", "reviewer", "qa", "design_reviewer", "integrator"];
export const ROLES_BY_KIND: Record<TaskKind, string[]> = {
  normal: DEV_ROLES,
  test_infra: DEV_ROLES,
  planning: ["researcher", "strategist", "product", "ux", "handoff", "critic"],
};

/** タスクの種類ごとの人の関門 */
const GATES_BY_KIND: Record<TaskKind, HumanApprovalKind[]> = {
  normal: ["plan", "design", "final"],
  test_infra: ["plan", "design", "final"],
  planning: ["strategy", "scope", "handoff"],
};

/** 役割を起動する前に承認されていなければならない関門 */
const ROLE_REQUIRES: Record<string, HumanApprovalKind[]> = {
  product: ["strategy"],
  ux: ["scope"],
  handoff: ["scope"],
  architect: ["plan"],
  designer: ["plan"],
  implementer: ["plan"],
  reviewer: ["plan"],
  qa: ["plan"],
  design_reviewer: ["plan"],
  integrator: ["plan", "final"],
};

/** 承認を求める前に承認されていなければならない関門 */
const GATE_REQUIRES: Partial<Record<HumanApprovalKind, HumanApprovalKind[]>> = {
  scope: ["strategy"],
  handoff: ["scope"],
  design: ["plan"],
  final: ["plan"],
};

/** 完了にする前に承認されていなければならない関門 */
const COMPLETE_REQUIRES: Record<TaskKind, HumanApprovalKind[]> = {
  normal: ["plan", "final"],
  test_infra: ["plan", "final"],
  planning: ["strategy", "scope", "handoff"],
};

/** 却下が何回続いたら人に回すか */
export const MAX_CONSECUTIVE_REJECTIONS = 2;

/** 却下が consecutive 回続いたときの扱い */
export function afterRejection(consecutive: number): "ask_coordinator" | "needs_input" {
  return consecutive >= MAX_CONSECUTIVE_REJECTIONS ? "needs_input" : "ask_coordinator";
}

/** 1タスクあたりの上限に達していれば、その理由 */
export function limitReason(f: CoordinatorFacts, l: CoordinatorLimits): string | null {
  if (f.runCount >= l.maxRunsPerTask) return `役割の起動回数が上限(${l.maxRunsPerTask} 回)に達しました`;
  if (f.costUsd >= l.maxCostPerTaskUsd) return `費用が上限($${l.maxCostPerTaskUsd})に達しました(今 $${f.costUsd.toFixed(2)})`;
  return null;
}

const missing = (need: HumanApprovalKind[], f: CoordinatorFacts) => need.filter((g) => !f.approvals.includes(g));

export function validateMove(output: unknown, f: CoordinatorFacts, roles: Map<string, RoleDef>, l: CoordinatorLimits): MoveCheck {
  const reject = (reason: string): MoveCheck => ({ ok: false, kind: "rejected", reason });
  const coordinator = roles.get("coordinator");
  if (!coordinator) throw new Error("roles/coordinator.md がありません");
  let parsed: ReturnType<typeof parseVerdict>;
  try {
    parsed = parseVerdict(coordinator, output);
  } catch (e) {
    return reject((e as Error).message);
  }
  const x = parsed.extra as { role: string | null; input: string | null; question: string | null; gate: HumanApprovalKind | null; reason: string; deviatesFromDefault: boolean };
  const base: Base = { summary: parsed.summary, reason: x.reason.trim(), deviatesFromDefault: x.deviatesFromDefault };
  if (!base.reason) return reject("理由(reason)が空です");

  switch (parsed.verdict) {
    case "run_role": {
      const role = x.role?.trim();
      const input = x.input?.trim();
      if (!role) return reject("run_role には role(起動する役割)が要ります");
      if (!input) return reject("run_role には input(役割に渡す指示)が要ります");
      if (!roles.has(role)) return reject(`役割 ${role} はありません(役割は新しく作れません。使える役割から選んでください)`);
      if (!ROLES_BY_KIND[f.kind].includes(role)) return reject(`役割 ${role} はこのタスク(${f.kind})では呼べません。使える役割: ${ROLES_BY_KIND[f.kind].join(", ")}`);
      const need = missing(ROLE_REQUIRES[role] ?? [], f);
      if (need.length) return reject(`役割 ${role} の前に、人の承認(${need.join(", ")})が要ります`);
      if (role === "integrator" && !f.testsPassed) return reject("統合の前に、テストの再実行が合格している必要があります");
      const limit = limitReason(f, l);
      if (limit) return { ok: false, kind: "limit", reason: limit };
      return { ok: true, move: { ...base, type: "run_role", role, input } };
    }
    case "ask_human": {
      const question = x.question?.trim();
      if (!question) return reject("ask_human には question(人への問い)が要ります");
      return { ok: true, move: { ...base, type: "ask_human", question } };
    }
    case "request_approval": {
      const gate = x.gate;
      if (!gate) return reject("request_approval には gate(承認の種類)が要ります");
      if (!GATES_BY_KIND[f.kind].includes(gate)) return reject(`承認 ${gate} はこのタスク(${f.kind})にはありません。使える承認: ${GATES_BY_KIND[f.kind].join(", ")}`);
      if (f.approvals.includes(gate)) return reject(`承認 ${gate} はすでに承認済みです`);
      const need = missing(GATE_REQUIRES[gate] ?? [], f);
      if (need.length) return reject(`承認 ${gate} の前に、人の承認(${need.join(", ")})が要ります`);
      if (gate === "final" && !f.testsPassed) return reject("最終確認の前に、テストの再実行が合格している必要があります");
      return { ok: true, move: { ...base, type: "request_approval", gate } };
    }
    case "complete": {
      const need = missing(COMPLETE_REQUIRES[f.kind], f);
      if (need.length) return reject(`完了の前に、人の承認(${need.join(", ")})が要ります`);
      if (f.kind !== "planning") {
        if (!f.testsPassed) return reject("完了の前に、テストの再実行が合格している必要があります");
        if (!f.integrated) return reject("完了の前に、統合が済んでいる必要があります");
      }
      return { ok: true, move: { ...base, type: "complete" } };
    }
    case "fail":
      return { ok: true, move: { ...base, type: "fail" } };
    default:
      return reject(`一手の種類 ${parsed.verdict} は扱えません`);
  }
}
