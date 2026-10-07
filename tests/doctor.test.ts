import { describe, expect, it } from "vitest";
import { runChecks, type Probe, type CheckResult } from "../src/doctor/checks.ts";
import { compareVersions } from "../src/util/version.ts";

const AUTH_OK = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" });

function probe(over: Partial<Probe> & { outputs?: Record<string, string | null> } = {}): Probe {
  const outputs: Record<string, string | null> = {
    "git --version": "git version 2.50.1",
    "claude --version": "2.1.285 (Claude Code)",
    "claude auth status": AUTH_OK,
    "xcodebuild -version": "Xcode 26.4",
    "flutter --version": "Flutter 3.40.0",
    "maestro --version": null,
    ...over.outputs,
  };
  return {
    env: {},
    nodeVersion: "24.10.0",
    platform: "darwin",
    claudePath: "claude",
    exists: () => true,
    run: (cmd, args) => {
      const out = outputs[[cmd, ...args].join(" ")];
      return out == null ? { ok: false, stdout: "" } : { ok: true, stdout: out };
    },
    ...over,
  };
}

const find = (rs: CheckResult[], id: string) => {
  const r = rs.find((x) => x.id === id);
  if (!r) throw new Error(`check ${id} が無い`);
  return r;
};
const errors = (rs: CheckResult[]) => rs.filter((r) => r.level === "error").map((r) => r.id);

describe("compareVersions", () => {
  it("数値として比較する", () => {
    expect(compareVersions("2.1.285", "2.1.285")).toBe(0);
    expect(compareVersions("2.1.300", "2.1.285")).toBeGreaterThan(0);
    expect(compareVersions("2.1.99", "2.1.285")).toBeLessThan(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBeGreaterThan(0);
  });
});

describe("doctor のチェック", () => {
  it("前提がそろっていればエラーなし", () => {
    expect(errors(runChecks(probe()))).toEqual([]);
  });

  it("ANTHROPIC_API_KEY があれば警告する", () => {
    const r = find(runChecks(probe({ env: { ANTHROPIC_API_KEY: "sk-xxx" } })), "anthropic-api-key");
    expect(r.level).toBe("warn");
    expect(r.message).not.toContain("sk-xxx"); // 値は表示しない
  });

  it("ANTHROPIC_API_KEY が無ければ ok", () => {
    expect(find(runChecks(probe()), "anthropic-api-key").level).toBe("ok");
  });

  it("Node 24 未満はエラー、奇数版は警告", () => {
    expect(find(runChecks(probe({ nodeVersion: "22.12.0" })), "node").level).toBe("error");
    expect(find(runChecks(probe({ nodeVersion: "25.9.0" })), "node").level).toBe("warn");
    expect(find(runChecks(probe({ nodeVersion: "24.1.0" })), "node").level).toBe("ok");
  });

  it("claude が無い、または古ければエラー", () => {
    expect(find(runChecks(probe({ outputs: { "claude --version": null } })), "claude").level).toBe("error");
    expect(find(runChecks(probe({ outputs: { "claude --version": "2.1.200 (Claude Code)" } })), "claude").level).toBe("error");
  });

  it("git が無ければエラー", () => {
    expect(find(runChecks(probe({ outputs: { "git --version": null } })), "git").level).toBe("error");
  });

  it("認証: 未ログインはエラー、APIキー方式は警告、サブスクは ok(プラン名を表示)", () => {
    const notLogged = JSON.stringify({ loggedIn: false });
    expect(find(runChecks(probe({ outputs: { "claude auth status": notLogged } })), "auth").level).toBe("error");
    const apiKey = JSON.stringify({ loggedIn: true, authMethod: "api_key" });
    expect(find(runChecks(probe({ outputs: { "claude auth status": apiKey } })), "auth").level).toBe("warn");
    const ok = find(runChecks(probe()), "auth");
    expect(ok.level).toBe("ok");
    expect(ok.message).toContain("pro");
  });

  it("GitHub の認証情報があれば、エージェントには渡さないことを知らせる", () => {
    const rs = runChecks(probe({ env: { GITHUB_TOKEN: "t", SSH_AUTH_SOCK: "/s" } }));
    const r = find(rs, "github-credentials");
    expect(r.level).toBe("info");
    expect(r.message).toContain("GITHUB_TOKEN");
    expect(r.message).toContain("SSH_AUTH_SOCK");
  });

  it("サンドボックスが使えなければエラー", () => {
    expect(find(runChecks(probe({ exists: () => false })), "sandbox").level).toBe("error");
    expect(find(runChecks(probe({ platform: "win32" })), "sandbox").level).toBe("error");
  });

  it("任意の道具が無ければ、その機能を無効として info", () => {
    const r = find(runChecks(probe()), "tool:maestro");
    expect(r.level).toBe("info");
    expect(find(runChecks(probe()), "tool:xcodebuild").level).toBe("ok");
  });
});
