import { addEvent, listEvents } from "../db/store.ts";
import type { Db } from "../db/connection.ts";

/**
 * 同じ失敗の繰り返しの検出(設計メモ v0.18、8-3)。差し戻しのたびに理由の要点(key)を残し、
 * 直前の差し戻しと同じ理由なら、上限(maxReviewRounds)を待たずに人に回す。
 * 人が回答・引き取り・戻すをしたら、それより前の差し戻しとは比べない(人が状況を変えたため)
 */

export type BounceInfo = {
  /** 差し戻した段(tests / review / qa) */
  source: "tests" | "review" | "qa" | "critique";
  /** 理由の要点。空なら比べない */
  key: string;
  /** 人に見せる理由の要約 */
  summary: string;
  /** 役割自身が「前回と同じ」と判定した(レビュワーの repeated) */
  repeated?: boolean;
};

const FAIL_LINE = /(✗|×|✕|\bFAIL(ED)?\b|\bnot ok\b|AssertionError|Error:|\bfailing\b|\bfailed\b)/i;
const norm = (l: string) => l.replace(/\d+(\.\d+)?\s*(ms|s|秒)?/g, "#").replace(/\s+/g, " ").trim();

/** テストの出力から、失敗の要点(失敗の行。数字は除く)を取り出す */
export function testFailureKey(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const fails = lines.filter((l) => FAIL_LINE.test(l)).map(norm);
  const picked = fails.length ? fails : lines.slice(-15).map(norm);
  return [...new Set(picked)].sort().join("\n");
}

/** 人が状況を変えた出来事(この後の差し戻しは、前の差し戻しと比べない) */
const HUMAN_EVENTS = new Set(["answer", "return", "retry", "approve", "reject"]);

/** 直近の差し戻し(人が状況を変えた後のものだけ) */
export function lastBounce(db: Db, taskId: number): BounceInfo | undefined {
  const events = listEvents(db, taskId, 2000);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "bounce") return e.payload as BounceInfo;
    if (e.kind === "state_changed" && HUMAN_EVENTS.has(String((e.payload as { event?: unknown }).event))) return undefined;
  }
  return undefined;
}

/** 差し戻しを記録し、直前と同じ理由かを返す */
export function recordBounce(db: Db, taskId: number, b: BounceInfo): { repeated: boolean } {
  const prev = lastBounce(db, taskId);
  addEvent(db, { taskId, kind: "bounce", payload: b });
  if (!prev) return { repeated: false };
  return { repeated: !!b.repeated || (b.key !== "" && b.source === prev.source && b.key === prev.key) };
}
