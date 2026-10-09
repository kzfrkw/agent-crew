import { describe, expect, it } from "vitest";
import { applyAudit, checkReviewConsistency, mustIndexes, type Finding } from "../src/orchestrator/review-findings.ts";

const f = (severity: Finding["severity"], title = "t"): Finding => ({ severity, file: "src/a.ts", line: 3, title, detail: "d", suggestion: "s" });

describe("mustIndexes", () => {
  it("Must の指摘の位置(全指摘の中での添字)を返す", () => {
    expect(mustIndexes([f("nit"), f("must"), f("should"), f("must")])).toEqual([1, 3]);
    expect(mustIndexes([])).toEqual([]);
  });
});

describe("checkReviewConsistency(判定と指摘の整合)", () => {
  it("approve に Must があれば矛盾", () => {
    expect(checkReviewConsistency("approve", [f("must")])).toMatch(/Must/);
  });

  it("changes_requested に Must が無ければ矛盾(Should/Nit だけなら approve にする)", () => {
    expect(checkReviewConsistency("changes_requested", [f("should"), f("nit")])).toMatch(/Must/);
    expect(checkReviewConsistency("changes_requested", [])).toMatch(/Must/);
  });

  it("整合していれば null。Should/Nit は approve と両立する", () => {
    expect(checkReviewConsistency("approve", [f("should"), f("nit")])).toBeNull();
    expect(checkReviewConsistency("approve", [])).toBeNull();
    expect(checkReviewConsistency("changes_requested", [f("must"), f("nit")])).toBeNull();
  });

  it("need_human は指摘の内容を問わない", () => {
    expect(checkReviewConsistency("need_human", [])).toBeNull();
    expect(checkReviewConsistency("need_human", [f("must")])).toBeNull();
  });
});

describe("applyAudit(監査結果の反映)", () => {
  const findings = [f("must", "a"), f("should", "b"), f("must", "c")];

  it("invalid と判定された Must だけを却下し、valid と unverifiable は残す", () => {
    const r = applyAudit(findings, [
      { finding: 0, result: "invalid", evidence: "e0" },
      { finding: 2, result: "unverifiable", evidence: "e2" },
    ]);
    expect(r.dismissed).toEqual([0]);
    expect(r.standing).toEqual([2]);
  });

  it("判定が付かなかった Must は残す(却下には明示の根拠が要る)", () => {
    const r = applyAudit(findings, [{ finding: 0, result: "invalid", evidence: "e" }]);
    expect(r).toEqual({ standing: [2], dismissed: [0] });
  });

  it("全 Must が invalid なら残りは無い", () => {
    const r = applyAudit(findings, [
      { finding: 0, result: "invalid", evidence: "e" },
      { finding: 2, result: "invalid", evidence: "e" },
    ]);
    expect(r).toEqual({ standing: [], dismissed: [0, 2] });
  });

  it("Must ではない指摘や範囲外の番号への判定は無視する", () => {
    const r = applyAudit(findings, [
      { finding: 1, result: "invalid", evidence: "e" },
      { finding: 9, result: "invalid", evidence: "e" },
    ]);
    expect(r).toEqual({ standing: [0, 2], dismissed: [] });
  });

  it("同じ指摘に判定が複数あるときは、全部 invalid のときだけ却下する", () => {
    const mixed = applyAudit(findings, [
      { finding: 0, result: "invalid", evidence: "e" },
      { finding: 0, result: "valid", evidence: "e" },
    ]);
    expect(mixed.dismissed).toEqual([]);
    const allInvalid = applyAudit(findings, [
      { finding: 0, result: "invalid", evidence: "e" },
      { finding: 0, result: "invalid", evidence: "e" },
    ]);
    expect(allInvalid.dismissed).toEqual([0]);
  });
});
