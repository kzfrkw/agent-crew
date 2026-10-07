#!/bin/sh
# このリポジトリのgitフックを githooks/ に向ける(clone後に1回実行する)
set -eu
cd "$(dirname "$0")/.."
git config core.hooksPath githooks
echo "core.hooksPath=githooks を設定しました"
