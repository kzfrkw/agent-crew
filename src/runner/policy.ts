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

/** 実体のパスと、それと異なる別名(あれば) */
function withAlias(real: string, alias?: string): string[] {
  if (!alias || alias === real) return [real];
  if (!isAbsolute(alias)) throw new Error(`絶対パスが必要です: ${alias}`);
  return [real, alias];
}

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
  /**
   * worktree / 成果物ディレクトリの別名(シンボリックリンク経由の表記)。
   * 権限ルールはパスを文字列で照合するため、エージェントが別名で書いても拒否されないよう同じ許可を出す。
   * サンドボックスはOSが実体のパスで判定するので、別名は不要。
   */
  aliases?: { worktree?: string; artifactsDir?: string };
  /** 追加で許可する道具(MCP の道具など) */
  extraAllow?: string[];
  /** Bash から追加で書ける場所(道具のキャッシュ)。Edit/Write の許可には足さない */
  extraWritable?: string[];
  /** 読ませないパス(絶対パス。7-4)。Read / Edit / Write の deny と、サンドボックスの資格情報の deny に入れる */
  denyRead?: string[];
  /**
   * 書かせないパス(絶対パス。v0.25)。作業場所の中でも書けない。人のリポジトリで直接作業するときの .git/hooks と .git/config
   * (書けると、人の次の git 操作でサンドボックスの外でコードが動き、push の止めも外せてしまう)
   */
  denyWrite?: string[];
}): RunSettings {
  for (const p of [o.worktree, o.artifactsDir, ...(o.extraWritable ?? []), ...(o.denyRead ?? []), ...(o.denyWrite ?? [])]) {
    if (!isAbsolute(p)) throw new Error(`絶対パスが必要です: ${p}`);
  }
  const wt = withAlias(o.worktree, o.aliases?.worktree);
  const art = withAlias(o.artifactsDir, o.aliases?.artifactsDir);
  const writable = o.write === "worktree" ? [...wt, ...art] : o.write === "artifacts" ? art : [];
  const bashCanWriteWorktree = o.write === "worktree" || (o.write === "artifacts" && o.bashWritesWorktree === true);
  return {
    disableAllHooks: true,
    permissions: {
      deny: [
        ...DENY,
        ...(o.denyRead ?? []).flatMap((p) => (["Read", "Edit", "Write"] as const).flatMap((t) => [`${t}(/${p})`, `${t}(/${p}/**)`])),
        ...(o.denyWrite ?? []).flatMap((p) => (["Edit", "Write"] as const).flatMap((t) => [`${t}(/${p})`, `${t}(/${p}/**)`])),
      ],
      allow: ["Read", "Grep", "Glob", "Bash", ...writable.flatMap((p) => [under("Edit", p), under("Write", p)]), ...(o.extraAllow ?? [])],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: o.write === "none" ? [] : [o.artifactsDir, ...(o.extraWritable ?? [])],
        denyWrite: [...(bashCanWriteWorktree ? [] : [o.worktree]), ...(o.denyWrite ?? [])],
      },
      network: o.localServer
        ? { allowedDomains: [...o.allowedDomains, "localhost", "127.0.0.1"], strictAllowlist: true, allowLocalBinding: true }
        : { allowedDomains: [...o.allowedDomains], strictAllowlist: true },
      credentials: {
        files: [...CREDENTIAL_FILES, ...(o.denyRead ?? [])].map((path) => ({ path, mode: "deny" as const })),
        envVars: CREDENTIAL_ENV.map((name) => ({ name, mode: "deny" as const })),
      },
    },
  };
}
