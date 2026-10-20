import { chmodSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * エージェントのworktreeだけに効かせるgitフック(docs/safety.md 5章)。
 * pre-push は常に失敗し、それ以外はリポジトリ本来のフックに中継する。
 */

const DELEGATED_HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "post-rewrite",
  "pre-auto-gc",
];

const PRE_PUSH = `#!/bin/sh
# agent-crew: エージェントのworktreeからの push は常に拒否する
echo "agent-crew: エージェントのworktreeからの push は禁止されています。push は人が普段のチェックアウトから行ってください。" >&2
exit 1
`;

/** エージェントの実行中(AGENT_CREW_ROLE あり)のコミットに trailer を付ける。--no-verify でも動く */
const ROLE_TRAILER_PRELUDE = `if [ -n "\${AGENT_CREW_ROLE:-}" ] && [ -n "$1" ]; then
  git interpret-trailers --in-place --if-exists replace --trailer "Agent-Crew-Role: $AGENT_CREW_ROLE" "$1" || true
fi
`;

const delegate = (name: string, hooksDir: string) => `#!/bin/sh
# agent-crew: リポジトリ本来の ${name} フックに中継する
${name === "prepare-commit-msg" ? ROLE_TRAILER_PRELUDE : ""}common=$(git rev-parse --git-common-dir) || exit 0
case "$common" in /*) ;; *) common="$(pwd)/$common" ;; esac
orig=$(git config --file "$common/config" --get core.hooksPath)
if [ -z "$orig" ]; then orig="$common/hooks"; fi
case "$orig" in
  /*) ;;
  "~"*) orig="$HOME\${orig#\\~}" ;;
  *) orig="$(git rev-parse --show-toplevel)/$orig" ;;
esac
# 自分自身への中継(無限ループ)を避ける
[ "$orig" = "${hooksDir}" ] && exit 0
hook="$orig/${name}"
if [ -x "$hook" ]; then exec "$hook" "$@"; fi
exit 0
`;

export function agentHooksDir(home: string): string {
  return join(home, "hooks");
}

/** フックを書き出す(何度呼んでもよい) */
export function installAgentHooks(home: string): string {
  const dir = agentHooksDir(home);
  mkdirSync(dir, { recursive: true });
  const write = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };
  write("pre-push", PRE_PUSH);
  for (const name of DELEGATED_HOOKS) write(name, delegate(name, dir));
  return dir;
}

/**
 * 作業場所が人のリポジトリそのもの(.git がディレクトリ。workspace: repo、v0.25)なら、worktree の代わりの守りを足す:
 * .git/hooks と .git/config を書かせない(書けると人の次の git 操作でサンドボックスの外でコードが動く)、
 * push を止めるフックはエージェントの git にだけ環境変数で効かせる(人のリポジトリの設定は変えない)
 */
export function inPlaceGuards(home: string, cwd: string): { denyWrite: string[]; env: Record<string, string> } | undefined {
  const dotGit = join(cwd, ".git");
  if (!existsSync(dotGit) || !statSync(dotGit).isDirectory()) return undefined;
  const git = join(realpathSync(cwd), ".git");
  return {
    denyWrite: [join(git, "hooks"), join(git, "config"), join(git, "config.worktree")],
    env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: agentHooksDir(home) },
  };
}
