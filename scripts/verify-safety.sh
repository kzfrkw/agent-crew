#!/bin/sh
# ステップ0の安全設定を検査する。失敗した項目があれば非0で終わる。
set -u
cd "$(dirname "$0")/.." || exit 1
fail=0
ok()  { echo "ok   - $1"; }
ng()  { echo "FAIL - $1"; fail=1; }

hook=githooks/pre-push
if [ -x "$hook" ]; then ok "pre-push フックが実行可能"; else ng "pre-push フックが無い/実行不可"; fi

# エージェント由来(CLAUDECODE / AGENT_CREW_RUN)の push は失敗し、人の push は通る
if [ -x "$hook" ]; then
  env -u AGENT_CREW_RUN CLAUDECODE=1 "$hook" origin url </dev/null >/dev/null 2>&1 && ng "CLAUDECODE=1 で push が通ってしまう" || ok "CLAUDECODE=1 で push を拒否"
  env -u CLAUDECODE AGENT_CREW_RUN=1 "$hook" origin url </dev/null >/dev/null 2>&1 && ng "AGENT_CREW_RUN=1 で push が通ってしまう" || ok "AGENT_CREW_RUN=1 で push を拒否"
  env -u CLAUDECODE -u AGENT_CREW_RUN "$hook" origin url </dev/null >/dev/null 2>&1 && ok "人の push は通す" || ng "人の push まで止めてしまう"
fi

[ "$(git config --get core.hooksPath)" = "githooks" ] && ok "core.hooksPath=githooks" || ng "core.hooksPath が githooks でない(scripts/install-hooks.sh を実行)"

s=.claude/settings.json
if [ -f "$s" ] && node -e "JSON.parse(require('fs').readFileSync('$s','utf8'))" 2>/dev/null; then
  ok "$s が正しいJSON"
  for rule in 'Bash(git push)' 'Bash(git push *)' 'Bash(gh *)' 'Bash(git remote add *)' 'Bash(git remote set-url *)' 'Read(~/.ssh/**)' 'Read(**/.env)'; do
    node -e "const s=JSON.parse(require('fs').readFileSync('$s','utf8'));process.exit((s.permissions?.deny??[]).includes(process.argv[1])?0:1)" "$rule" \
      && ok "deny: $rule" || ng "deny に $rule が無い"
  done
else
  ng "$s が無い/JSONとして不正"
fi

[ -f docs/safety.md ] && ok "docs/safety.md がある" || ng "docs/safety.md が無い"
grep -q '^# AI開発チーム基盤 設計メモ (v0.7)' docs/design-memo.md && ok "設計メモ v0.7" || ng "設計メモが v0.7 になっていない"

exit $fail
