import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listEvents, listTaskRepos, listValidApprovals } from "../src/db/store.ts";
import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { headSha } from "../src/git/worktree.ts";
import { latestNeedsInputReason, runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { sh } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const planner = answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false });
const implementer: Script = (spec: RunSpec, n) => {
  writeFileSync(join(spec.cwd, `feature${n}.js`), `export const f = ${n};\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...spec.extraEnv };
  sh(spec.cwd, "git", ["add", "."], env);
  sh(spec.cwd, "git", ["commit", "-q", "-m", `feat ${n}`], env);
  writeArtifact(spec, "impl-notes.md", "done");
  return { structuredOutput: { verdict: "done", summary: "s", testCommand: null } };
};
const verifier = (pass: boolean): Script => () => ({
  structuredOutput: { verdict: pass ? "passed" : "failed", summary: "s" },
  bashResults: [{ command: "npm test", isError: !pass, output: pass ? "ok" : "fail" }],
});

const finding = (severity: "must" | "should" | "nit", title = `${severity}の指摘`) => ({ severity, file: "feature0.js", line: 1, title, detail: "詳細", suggestion: "直し方" });
const review = (verdict: string, findings: ReturnType<typeof finding>[] = []) => answer("review.md", verdict, { findings });
const audit = (verdict: string, judgments: { finding: number; result: "valid" | "invalid" | "unverifiable"; evidence?: string }[]) =>
  answer("audit.md", verdict, { judgments: judgments.map((j) => ({ evidence: "根拠", ...j })) });
/** 1回目だけ指定の台本、2回目以降は approve を返すレビュワー */
const reviewOnce = (first: Script): Script => (spec, n) => (n === 0 ? first(spec, n) : review("approve")(spec, n));

async function implemented(scripts: Record<string, Script>, config: Parameters<typeof testContext>[1] = {}) {
  const runner = new ScriptedRunner({ planner, implementer, verifier: verifier(true), qa: answer("qa-report.md", "passed"), auditor: audit("upheld", [{ finding: 0, result: "valid" }]), ...scripts });
  const ctx = testContext(runner, config);
  const { project } = await approvedProject(ctx);
  const t = newTask(ctx, project.id);
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "plan");
  await runUntilIdle(ctx);
  return { ctx, t, runner };
}

describe("レビュワー", () => {
  it("テストの再実行が通ったらレビューし、approve で QA へ進む。承認は HEAD に紐づく", async () => {
    const { ctx, t, runner } = await implemented({ reviewer: review("approve") });
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(runner.rolesCalled()).toEqual(["planner", "implementer", "verifier", "reviewer", "qa"]);
    const tr = listTaskRepos(ctx.db, t.id)[0]!;
    const approval = listValidApprovals(ctx.db, t.id).find((a) => a.kind === "review")!;
    expect(approval).toMatchObject({ result: "approved", commitSha: headSha(tr.worktreePath, ctx.gitEnv), repoId: tr.repoId });
    const dir = taskDir(ctx.home, t.id);
    expect(readFileSync(join(dir, "diff.patch"), "utf8")).toContain("feature0.js");
    expect(existsSync(join(dir, "test-changes.md"))).toBe(true);
    const call = runner.calls.find((c) => c.role === "reviewer")!;
    expect(call.prompt).toContain("diff.patch");
    expect(call.prompt).toContain("test-changes.md");
    expect(call.write).toBe("artifacts");
  });

  it("テストの再実行が失敗したら、レビューせずに実装者へ差し戻す", async () => {
    const { ctx, t, runner } = await implemented({ verifier: verifier(false), reviewer: review("approve") });
    // 差し戻し → 実装 → 再実行失敗 … を上限まで繰り返して needs_input
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "implementing" });
    expect(runner.rolesCalled()).not.toContain("reviewer");
    expect(runner.rolesCalled().filter((r) => r === "implementer")).toHaveLength(4);
    expect(latestNeedsInputReason(ctx.db, t.id)).toBeDefined();
  });

  it("changes_requested で実装者に戻り、実装者は review.md を読む", async () => {
    const { ctx, t, runner } = await implemented({
      reviewer: reviewOnce(review("changes_requested", [finding("must")])),
    });
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "awaiting_final_approval", reviewRounds: 1 });
    const second = runner.calls.filter((c) => c.role === "implementer")[1]!;
    expect(second.prompt).toContain("review.md");
    expect(second.prompt).toContain("差し戻しの回数: 1");
  });

  it("人のコミットが含まれていれば、レビュワーに伝える", async () => {
    const { ctx, t, runner } = await implemented({
      verifier: verifier(true),
      reviewer: (spec, n) => {
        if (n === 0) {
          // 1回目のレビューの前に、人が同じブランチにコミットした状況を作る
          writeFileSync(join(spec.cwd, "by-human.js"), "x");
          sh(spec.cwd, "git", ["add", "."], { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Human", GIT_AUTHOR_EMAIL: "h@x", GIT_COMMITTER_NAME: "Human", GIT_COMMITTER_EMAIL: "h@x" });
          sh(spec.cwd, "git", ["commit", "-q", "-m", "fix by human"], { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Human", GIT_AUTHOR_EMAIL: "h@x", GIT_COMMITTER_NAME: "Human", GIT_COMMITTER_EMAIL: "h@x" });
          return review("changes_requested", [finding("must")])(spec, n);
        }
        return review("approve")(spec, n);
      },
    });
    const secondReview = runner.calls.filter((c) => c.role === "reviewer")[1]!;
    expect(secondReview.prompt).toContain("fix by human");
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
  });
});

describe("レビュワー: 指摘の重大度", () => {
  it("Should / Nit だけなら approve でき、指摘は記録され、監査は動かない", async () => {
    const { ctx, t, runner } = await implemented({ reviewer: review("approve", [finding("should"), finding("nit")]) });
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(runner.rolesCalled()).not.toContain("auditor");
    const ev = listEvents(ctx.db, t.id).find((e) => e.kind === "review_findings")!;
    expect((ev.payload as any).findings.map((x: any) => x.severity)).toEqual(["should", "nit"]);
  });

  it("approve なのに Must がある矛盾は、人に確認する(承認は付かない)", async () => {
    const { ctx, t, runner } = await implemented({ reviewer: review("approve", [finding("must")]) });
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "reviewing" });
    expect(latestNeedsInputReason(ctx.db, t.id)).toMatch(/Must/);
    expect(listValidApprovals(ctx.db, t.id).filter((a) => a.kind === "review")).toEqual([]);
    expect(runner.rolesCalled()).not.toContain("auditor");
  });

  it("changes_requested なのに Must が無い矛盾は、人に確認する", async () => {
    const { ctx, t } = await implemented({ reviewer: review("changes_requested", [finding("should")]) });
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "reviewing" });
    expect(latestNeedsInputReason(ctx.db, t.id)).toMatch(/Must/);
  });
});

describe("レビュワー: Must 指摘の監査(auditor)", () => {
  const musts = [finding("must", "A"), finding("should", "B"), finding("must", "C")];

  it("Must が支持されたら、実装者に差し戻す。実装者は audit.md も読む", async () => {
    const { ctx, t, runner } = await implemented({
      reviewer: reviewOnce(review("changes_requested", musts)),
      auditor: audit("upheld", [{ finding: 0, result: "valid" }, { finding: 2, result: "invalid" }]),
    });
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "awaiting_final_approval", reviewRounds: 1 });
    expect(runner.rolesCalled().slice(0, 6)).toEqual(["planner", "implementer", "verifier", "reviewer", "auditor", "implementer"]);
    const a = runner.calls.find((c) => c.role === "auditor")!;
    // 監査に渡すのは Must だけ(番号は全指摘の中での位置)。Should は渡さない
    expect(a.prompt).toContain("[0]");
    expect(a.prompt).toContain("A");
    expect(a.prompt).toContain("[2]");
    expect(a.prompt).not.toContain("[1]");
    expect(a.prompt).toContain("diff.patch");
    // 読み取り専用で、成果物にだけ書ける
    expect(a.write).toBe("artifacts");
    expect(a.tools).not.toContain("Bash");
    const second = runner.calls.filter((c) => c.role === "implementer")[1]!;
    expect(second.prompt).toContain("audit.md");
  });

  it("全ての Must が却下されたら approve として QA へ進む(承認は HEAD に紐づく)", async () => {
    const { ctx, t, runner } = await implemented({
      reviewer: review("changes_requested", musts),
      auditor: audit("overturned", [{ finding: 0, result: "invalid" }, { finding: 2, result: "invalid" }]),
    });
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "awaiting_final_approval", reviewRounds: 0 });
    expect(runner.rolesCalled()).toEqual(["planner", "implementer", "verifier", "reviewer", "auditor", "qa"]);
    const tr = listTaskRepos(ctx.db, t.id)[0]!;
    expect(listValidApprovals(ctx.db, t.id).find((a) => a.kind === "review")).toMatchObject({ result: "approved", commitSha: headSha(tr.worktreePath, ctx.gitEnv) });
    const changed = listEvents(ctx.db, t.id).find((e) => e.kind === "state_changed" && (e.payload as any).from === "reviewing")!;
    expect((changed.payload as any).reason).toMatch(/auditor/);
  });

  it("overturned と言っても、判定が全 Must をカバーしていなければ差し戻す", async () => {
    const { ctx, t, runner } = await implemented({
      reviewer: reviewOnce(review("changes_requested", musts)),
      auditor: audit("overturned", [{ finding: 0, result: "invalid" }]),
    });
    expect(runner.rolesCalled().slice(3, 6)).toEqual(["reviewer", "auditor", "implementer"]);
    expect(getTask(ctx.db, t.id)!.reviewRounds).toBe(1);
    expect(listEvents(ctx.db, t.id).some((e) => e.kind === "warning")).toBe(true);
  });

  it("auditor が need_human なら人に確認する", async () => {
    const { ctx, t } = await implemented({ reviewer: review("changes_requested", musts), auditor: audit("need_human", []) });
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "reviewing" });
  });

  it("auditor が失敗しても止まらず、reviewer の判定で差し戻す(警告を残す)", async () => {
    const { ctx, t, runner } = await implemented({
      reviewer: reviewOnce(review("changes_requested", musts)),
      auditor: () => {
        throw new Error("boom");
      },
    });
    expect(runner.rolesCalled().slice(3, 6)).toEqual(["reviewer", "auditor", "implementer"]);
    expect(getTask(ctx.db, t.id)!.reviewRounds).toBe(1);
    expect(listEvents(ctx.db, t.id).some((e) => e.kind === "warning")).toBe(true);
  });

  it("設定で監査を止められる", async () => {
    const { ctx, t, runner } = await implemented(
      { reviewer: reviewOnce(review("changes_requested", musts)) },
      { review: { ...DEFAULT_CONFIG.review, audit: false } },
    );
    expect(runner.rolesCalled()).not.toContain("auditor");
    expect(getTask(ctx.db, t.id)!.reviewRounds).toBe(1);
  });

  it("前の周回の audit.md は、次の周回に残さない", async () => {
    const { ctx, t } = await implemented({ reviewer: reviewOnce(review("changes_requested", musts)) });
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(existsSync(join(taskDir(ctx.home, t.id), "audit.md"))).toBe(false);
  });
});
