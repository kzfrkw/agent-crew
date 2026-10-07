import { describe, expect, it } from "vitest";
import { buildRunSettings } from "../src/runner/policy.ts";
import { buildAgentEnv } from "../src/runner/env.ts";
import { buildClaudeArgs } from "../src/runner/args.ts";

const base = { worktree: "/h/worktrees/p/1/main", artifactsDir: "/h/tasks/1", allowedDomains: ["registry.npmjs.org"] };

describe("buildRunSettings", () => {
  it("共通: フック無効、push系のdeny、サンドボックスは管理者必須の形", () => {
    const s = buildRunSettings({ ...base, write: "worktree" });
    expect(s.disableAllHooks).toBe(true);
    expect(s.permissions.deny).toEqual(expect.arrayContaining(["Bash(git push)", "Bash(git push *)", "Bash(gh *)", "Bash(git config *)", "Read(~/.ssh/**)"]));
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(s.sandbox.network).toEqual({ allowedDomains: ["registry.npmjs.org"], strictAllowlist: true });
    expect(s.sandbox.credentials.files.map((f) => f.path)).toEqual(expect.arrayContaining(["~/.ssh", "~/.aws", "~/.config/gh"]));
  });

  it("パス無しの Edit/Write は決して許可しない", () => {
    for (const write of ["none", "artifacts", "worktree"] as const) {
      const allow = buildRunSettings({ ...base, write }).permissions.allow;
      expect(allow).not.toContain("Edit");
      expect(allow).not.toContain("Write");
    }
  });

  it("worktree: worktree と成果物ディレクトリに書ける", () => {
    const s = buildRunSettings({ ...base, write: "worktree" });
    expect(s.permissions.allow).toEqual(expect.arrayContaining([
      "Edit(//h/worktrees/p/1/main/**)", "Write(//h/worktrees/p/1/main/**)", "Edit(//h/tasks/1/**)", "Write(//h/tasks/1/**)",
    ]));
    expect(s.sandbox.filesystem.denyWrite).toEqual([]);
    expect(s.sandbox.filesystem.allowWrite).toEqual(["/h/tasks/1"]);
  });

  it("artifacts: 成果物ディレクトリだけに書け、Bash からも worktree に書けない", () => {
    const s = buildRunSettings({ ...base, write: "artifacts" });
    expect(s.permissions.allow.filter((a) => a.startsWith("Edit") || a.startsWith("Write"))).toEqual(["Edit(//h/tasks/1/**)", "Write(//h/tasks/1/**)"]);
    expect(s.sandbox.filesystem.denyWrite).toEqual(["/h/worktrees/p/1/main"]);
  });

  it("artifacts でも、ビルド・テストが要る役割は Bash から worktree に書ける", () => {
    const s = buildRunSettings({ ...base, write: "artifacts", bashWritesWorktree: true });
    expect(s.sandbox.filesystem.denyWrite).toEqual([]);
    expect(s.permissions.allow.some((a) => a.includes("/h/worktrees"))).toBe(false); // Edit/Write ツールは不可のまま
  });

  it("none: どこにも書けない", () => {
    const s = buildRunSettings({ ...base, write: "none" });
    expect(s.permissions.allow.filter((a) => a.startsWith("Edit") || a.startsWith("Write"))).toEqual([]);
    expect(s.sandbox.filesystem).toEqual({ allowWrite: [], denyWrite: ["/h/worktrees/p/1/main"] });
  });

  it("相対パスは受け付けない", () => {
    expect(() => buildRunSettings({ ...base, worktree: "rel/wt", write: "worktree" })).toThrow(/絶対パス/);
  });
});

describe("buildAgentEnv", () => {
  const parent = {
    PATH: "/bin", HOME: "/Users/u", USER: "u", LANG: "ja_JP.UTF-8", LC_ALL: "C", TERM: "xterm", TMPDIR: "/tmp/", SHELL: "/bin/zsh",
    ANTHROPIC_API_KEY: "sk", GITHUB_TOKEN: "gh", GH_TOKEN: "gh", SSH_AUTH_SOCK: "/s", AWS_SECRET_ACCESS_KEY: "a", NPM_TOKEN: "n",
    CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", RANDOM_VAR: "r",
  };

  it("許可リストの変数だけを渡し、目印を足す", () => {
    expect(buildAgentEnv(parent)).toEqual({
      PATH: "/bin", HOME: "/Users/u", USER: "u", LANG: "ja_JP.UTF-8", LC_ALL: "C", TERM: "xterm", TMPDIR: "/tmp/", SHELL: "/bin/zsh",
      AGENT_CREW_RUN: "1", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
  });

  it("呼び出し側が明示した変数は足せるが、認証情報は足せない", () => {
    const env = buildAgentEnv(parent, { GIT_AUTHOR_NAME: "agent-crew implementer" });
    expect(env.GIT_AUTHOR_NAME).toBe("agent-crew implementer");
    expect(() => buildAgentEnv(parent, { GITHUB_TOKEN: "x" })).toThrow(/渡せません/);
    expect(() => buildAgentEnv(parent, { ANTHROPIC_API_KEY: "x" })).toThrow(/渡せません/);
  });
});

describe("buildClaudeArgs", () => {
  const spec = {
    model: "opus", effort: "high" as const, tools: ["Read", "Grep", "Bash"], settingsPath: "/h/runs/9/settings.json",
    jsonSchema: { type: "object" }, artifactsDir: "/h/tasks/1", maxBudgetUsd: 3, systemPromptAppend: "あなたはレビュワーです",
  };

  it("安全のための固定オプションが必ず入る", () => {
    const a = buildClaudeArgs(spec);
    expect(a[0]).toBe("-p");
    const pairs = (flag: string) => a[a.indexOf(flag) + 1];
    expect(pairs("--setting-sources")).toBe("");
    expect(a).toContain("--strict-mcp-config");
    expect(pairs("--settings")).toBe("/h/runs/9/settings.json");
    expect(pairs("--permission-mode")).toBe("dontAsk");
    expect(pairs("--permission-prompts")).toBe("none");
    expect(pairs("--output-format")).toBe("stream-json");
    expect(a).toContain("--verbose");
    expect(a).not.toContain("--bare");
    expect(a).not.toContain("--dangerously-skip-permissions");
  });

  it("役割ごとの値を渡す", () => {
    const a = buildClaudeArgs(spec);
    const pairs = (flag: string) => a[a.indexOf(flag) + 1];
    expect(pairs("--model")).toBe("opus");
    expect(pairs("--effort")).toBe("high");
    expect(pairs("--tools")).toBe("Read,Grep,Bash");
    expect(pairs("--add-dir")).toBe("/h/tasks/1");
    expect(pairs("--max-budget-usd")).toBe("3");
    expect(pairs("--json-schema")).toBe('{"type":"object"}');
    expect(pairs("--append-system-prompt")).toBe("あなたはレビュワーです");
  });

  it("resume を指定したときだけ --resume を付ける", () => {
    expect(buildClaudeArgs(spec)).not.toContain("--resume");
    const a = buildClaudeArgs({ ...spec, resumeSessionId: "s-1" });
    expect(a[a.indexOf("--resume") + 1]).toBe("s-1");
  });

  it("プロンプトは引数に入れない(標準入力で渡す)", () => {
    expect(buildClaudeArgs(spec).at(-1)).not.toMatch(/\s/);
  });
});

describe("localServer(QA)", () => {
  it("127.0.0.1 での待ち受けと接続を許可する", () => {
    const s = buildRunSettings({ ...base, write: "artifacts", bashWritesWorktree: true, localServer: true });
    expect(s.sandbox.network.allowedDomains).toEqual(expect.arrayContaining(["registry.npmjs.org", "localhost", "127.0.0.1"]));
    expect(s.sandbox.network.allowLocalBinding).toBe(true);
  });
  it("既定では許可しない", () => {
    const s = buildRunSettings({ ...base, write: "artifacts" });
    expect(s.sandbox.network.allowLocalBinding).toBeUndefined();
    expect(s.sandbox.network.allowedDomains).not.toContain("127.0.0.1");
  });
});

describe("--allowedTools", () => {
  it("settings の allow ルールと同じものを明示する(環境変数の除去で権限モードが default に強制されるため)", () => {
    const a = buildClaudeArgs({
      model: "sonnet", tools: ["Read"], settingsPath: "/s.json", jsonSchema: {}, artifactsDir: "/a", maxBudgetUsd: 1,
      systemPromptAppend: "x", allowedTools: ["Read", "Edit(//a/**)"],
    });
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("Read,Edit(//a/**)");
  });
});
