import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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

const delegate = (name: string, hooksDir: string) => `#!/bin/sh
# agent-crew: リポジトリ本来の ${name} フックに中継する
common=$(git rev-parse --git-common-dir) || exit 0
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
