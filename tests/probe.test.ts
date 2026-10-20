import { describe, expect, it } from "vitest";
import { evaluateProbe, evaluateRepoProbe, runProbe, runRepoProbe, type ProbeObservation, type RepoProbeObservation } from "../src/doctor/probe.ts";
import { tempDir } from "./helpers/gitrepo.ts";

const fake = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;

const good: ProbeObservation = {
  runStatus: "succeeded",
  results: {
    rc_inside: "0", rc_outside: "1", rc_ssh: "1", token: "", github_code: "000", npm_code: "200",
    rc_commit: "0", rc_push: "1", rc_hookcfg: "255", rc_protected: "1",
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
    { tool: "Read", input: { file_path: "/x/wt/protected/secret.txt" } },
  ],
  protectedReadByModel: false,
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

  it("読ませないパス(7-4)を Bash で読めたり、Read が拒否されなかったり、中身がモデルに見えたらエラー", () => {
    expect(levels({ ...good, results: { ...good.results, rc_protected: "0" } })["probe:protect-bash"]).toBe("error");
    expect(levels({ ...good, denials: good.denials.filter((d) => d.tool !== "Read") })["probe:protect-read"]).toBe("error");
    expect(levels({ ...good, protectedReadByModel: true })["probe:protect-read"]).toBe("error");
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

/** 人のリポジトリで直接作業する方式(workspace: repo。v0.25)の検査 */
const repoGood: RepoProbeObservation = {
  runStatus: "succeeded",
  results: { rc_inside: "0", rc_commit: "0", rc_hookwrite: "1", rc_cfgwrite: "1", rc_gitcfg: "255", hookpath: "/h/hooks", rc_push: "1" },
  agentHooksDir: "/h/hooks",
  insideFileExists: true,
  probeCommitExists: true,
  bashHookFileExists: false,
  writeToolHookFileExists: false,
  repoConfigHooksPath: "",
  remoteUpdated: false,
  humanPushSucceeded: true,
  denials: [
    { tool: "Bash", input: { command: "git push origin HEAD" } },
    { tool: "Write", input: { file_path: "/x/repo/.git/hooks/post-checkout" } },
  ],
};
const repoLevels = (o: RepoProbeObservation) => Object.fromEntries(evaluateRepoProbe(o).map((r) => [r.id, r.level]));

describe("evaluateRepoProbe(人のリポジトリで直接作業する)", () => {
  it("すべて想定どおりなら全部 ok", () => {
    expect(Object.values(repoLevels(repoGood)).every((l) => l === "ok")).toBe(true);
    expect(Object.keys(repoLevels(repoGood)).every((id) => id.startsWith("probe-repo:"))).toBe(true);
  });

  it(".git/hooks にフックを置けてしまったらエラー(Bash からも Write ツールからも)", () => {
    expect(repoLevels({ ...repoGood, bashHookFileExists: true })["probe-repo:hooks-bash"]).toBe("error");
    expect(repoLevels({ ...repoGood, writeToolHookFileExists: true })["probe-repo:hooks-write"]).toBe("error");
    expect(repoLevels({ ...repoGood, denials: repoGood.denials.filter((d) => d.tool !== "Write") })["probe-repo:hooks-write"]).toBe("error");
  });

  it(".git/config を書き換えられたらエラー", () => {
    expect(repoLevels({ ...repoGood, repoConfigHooksPath: "/tmp/agent-crew-probe-evil" })["probe-repo:config"]).toBe("error");
  });

  it("エージェントの git にフックの場所が効いていなければエラー", () => {
    expect(repoLevels({ ...repoGood, results: { ...repoGood.results, hookpath: "" } })["probe-repo:agent-hooks"]).toBe("error");
  });

  it("エージェントの push が届いたらエラー。人の push が止まっていてもエラー", () => {
    expect(repoLevels({ ...repoGood, remoteUpdated: true })["probe-repo:push"]).toBe("error");
    expect(repoLevels({ ...repoGood, humanPushSucceeded: false })["probe-repo:human-push"]).toBe("error");
  });

  it("リポジトリで作業できなければエラー(厳しすぎる設定も検出する)", () => {
    expect(repoLevels({ ...repoGood, probeCommitExists: false })["probe-repo:commit"]).toBe("error");
    expect(repoLevels({ ...repoGood, insideFileExists: false })["probe-repo:write"]).toBe("error");
  });
});

describe("runRepoProbe(偽の claude)", () => {
  it("エージェントが何も実行しなかった場合、誤って合格しない。人の push は通る", async () => {
    const home = tempDir("agent-crew-probe-");
    const results = await runRepoProbe({ home, claudePath: fake, allowedDomains: [], keep: false });
    const level = Object.fromEntries(results.map((r) => [r.id, r.level]));
    expect(level["probe-repo:write"]).toBe("error");
    expect(level["probe-repo:commit"]).toBe("error");
    expect(level["probe-repo:hooks-write"]).toBe("error");
    expect(level["probe-repo:human-push"]).toBe("ok");
  }, 60_000);
});
