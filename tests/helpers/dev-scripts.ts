import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunSpec } from "../../src/runner/types.ts";
import { sh } from "./gitrepo.ts";
import { answer, writeArtifact, type Script } from "./scripted-runner.ts";

/** 開発の流れを最後まで通す台本(実装者はコミットを1つ作る) */
export const agentEnv = (spec: RunSpec) => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...spec.extraEnv });
export const devScripts = (over: Record<string, Script> = {}): Record<string, Script> => ({
  planner: answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect: false, designer: false, reason: "小さな変更" } }),
  implementer: (spec, n) => {
    writeFileSync(join(spec.cwd, `f${n}.js`), "x");
    sh(spec.cwd, "git", ["add", "."], agentEnv(spec));
    sh(spec.cwd, "git", ["commit", "-q", "-m", `feat ${n}`], agentEnv(spec));
    writeArtifact(spec, "impl-notes.md", "done");
    return { structuredOutput: { verdict: "done", summary: "s", testCommand: null } };
  },
  verifier: (spec) => {
    const command = /```sh\n(.*)\n```/.exec(spec.prompt)![1]!;
    return { structuredOutput: { verdict: "passed", summary: "s" }, bashResults: [{ command, isError: false, output: "ok" }] };
  },
  reviewer: answer("review.md", "approve", { findings: [] }),
  qa: answer("qa-report.md", "passed"),
  integrator: answer("pr-draft.md", "done"),
  ...over,
});

