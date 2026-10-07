import { isAbsolute } from "node:path";
import type { WriteScope } from "./types.ts";

/**
 * 実行ごとに --settings で渡す設定(docs/safety.md 3.2)。
 * Edit/Write はパス付きでしか許可しない(パス無しだと worktree 外にも書けてしまうことを確認済み)。
 */

const DENY = [
  "Bash(git push)",
  "Bash(git push *)",
  "Bash(git -C * push *)",
  "Bash(git remote *)",
  "Bash(git config *)",
  "Bash(gh *)",
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.config/gh/**)",
  "Read(~/.agent-team/config.json)",
  "Read(**/.env)",
  "Read(**/.env.*)",
];

const CREDENTIAL_FILES = ["~/.ssh", "~/.aws", "~/.config/gh", "~/.netrc", "~/.npmrc"];
const CREDENTIAL_ENV = ["GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

export type RunSettings = {
  disableAllHooks: true;
  permissions: { deny: string[]; allow: string[] };
  sandbox: {
    enabled: true;
    failIfUnavailable: true;
    allowUnsandboxedCommands: false;
    filesystem: { allowWrite: string[]; denyWrite: string[] };
    network: { allowedDomains: string[]; strictAllowlist: true; allowLocalBinding?: true };
    credentials: {
      files: { path: string; mode: "deny" }[];
      envVars: { name: string; mode: "deny" }[];
    };
  };
};

/** 絶対パスを権限ルールの形(//abs/path/**)にする */
const under = (tool: "Edit" | "Write", abs: string) => `${tool}(/${abs.replace(/\/+$/, "")}/**)`;

export function buildRunSettings(o: {
  worktree: string;
  artifactsDir: string;
  write: WriteScope;
  bashWritesWorktree?: boolean;
  /** QA: 127.0.0.1 でアプリを起動し、接続する */
  localServer?: boolean;
  allowedDomains: string[];
}): RunSettings {
  for (const p of [o.worktree, o.artifactsDir]) {
    if (!isAbsolute(p)) throw new Error(`絶対パスが必要です: ${p}`);
  }
  const writable = o.write === "worktree" ? [o.worktree, o.artifactsDir] : o.write === "artifacts" ? [o.artifactsDir] : [];
  const bashCanWriteWorktree = o.write === "worktree" || (o.write === "artifacts" && o.bashWritesWorktree === true);
  return {
    disableAllHooks: true,
    permissions: {
      deny: [...DENY],
      allow: ["Read", "Grep", "Glob", "Bash", ...writable.flatMap((p) => [under("Edit", p), under("Write", p)])],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: o.write === "none" ? [] : [o.artifactsDir],
        denyWrite: bashCanWriteWorktree ? [] : [o.worktree],
      },
      network: o.localServer
        ? { allowedDomains: [...o.allowedDomains, "localhost", "127.0.0.1"], strictAllowlist: true, allowLocalBinding: true }
        : { allowedDomains: [...o.allowedDomains], strictAllowlist: true },
      credentials: {
        files: CREDENTIAL_FILES.map((path) => ({ path, mode: "deny" as const })),
        envVars: CREDENTIAL_ENV.map((name) => ({ name, mode: "deny" as const })),
      },
    },
  };
}
