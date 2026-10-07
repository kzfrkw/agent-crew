import { describe, expect, it } from "vitest";
import { evaluateProbe, runProbe, type ProbeObservation } from "../src/doctor/probe.ts";
import { tempDir } from "./helpers/gitrepo.ts";

const fake = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;

const good: ProbeObservation = {
  runStatus: "succeeded",
  results: {
    rc_inside: "0", rc_outside: "1", rc_ssh: "1", token: "", github_code: "000", npm_code: "200",
    rc_commit: "0", rc_push: "1", rc_hookcfg: "255",
  },
  insideFileExists: true,
  outsideFileExists: false,
  outsideWriteFileExists: false,
  sshDirExists: true,
  npmAllowed: true,
  probeCommitExists: true,
  remoteUpdated: false,
  hooksPathUnchanged: true,
  repoHookRan: false,
  denials: [
    { tool: "Bash", input: { command: "git push origin HEAD" } },
    { tool: "Write", input: { file_path: "/x/outside-write.txt" } },
  ],
};

const levels = (o: ProbeObservation) => Object.fromEntries(evaluateProbe(o).map((r) => [r.id, r.level]));

describe("evaluateProbe", () => {
  it("すべて想定どおりなら全部 ok", () => {
    expect(Object.values(levels(good)).every((l) => l === "ok")).toBe(true);
  });

  it("worktree外に書けてしまったらエラー", () => {
    expect(levels({ ...good, outsideFileExists: true })["probe:bash-write-outside"]).toBe("error");
    expect(levels({ ...good, outsideWriteFileExists: true })["probe:write-tool-outside"]).toBe("error");
  });

  it("認証情報が見えたらエラー", () => {
    expect(levels({ ...good, results: { ...good.results, token: "agent-crew-probe-secret" } })["probe:env-credentials"]).toBe("error");
    expect(levels({ ...good, results: { ...good.results, rc_ssh: "0" } })["probe:ssh-read"]).toBe("error");
  });

  it("~/.ssh が無いPCでは ssh の検査は info", () => {
    expect(levels({ ...good, sshDirExists: false, results: { ...good.results, rc_ssh: "1" } })["probe:ssh-read"]).toBe("info");
  });

  it("GitHub に届いたらエラー", () => {
    expect(levels({ ...good, results: { ...good.results, github_code: "200" } })["probe:network-github"]).toBe("error");
  });

  it("push が remote に届いたり、deny が効かなかったらエラー", () => {
    expect(levels({ ...good, remoteUpdated: true })["probe:push-hook"]).toBe("error");
    expect(levels({ ...good, denials: good.denials.filter((d) => d.tool !== "Bash") })["probe:push-deny"]).toBe("error");
  });

  it("リポジトリ側のフックが動いたらエラー", () => {
    expect(levels({ ...good, repoHookRan: true })["probe:repo-hooks"]).toBe("error");
  });

  it("worktree内で作業できなければエラー(厳しすぎる設定も検出する)", () => {
    expect(levels({ ...good, probeCommitExists: false })["probe:worktree-commit"]).toBe("error");
  });
});

describe("runProbe(偽の claude)", () => {
  it("エージェントが何も実行しなかった場合、誤って合格しない", async () => {
    const home = tempDir("agent-crew-probe-");
    const results = await runProbe({ home, claudePath: fake, allowedDomains: [], keep: false });
    const errorIds = results.filter((r) => r.level === "error").map((r) => r.id);
    expect(errorIds).toEqual(expect.arrayContaining(["probe:worktree-write", "probe:worktree-commit", "probe:push-deny", "probe:write-deny"]));
  }, 60_000);
});
