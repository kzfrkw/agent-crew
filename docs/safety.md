# 安全設定の実装方針

設計メモの第7章(安全方針)を、実際の設定とコードにどう落とすかをまとめる。設計メモと食い違ったら、設計メモ側を正とし、両方を更新する。

検証環境: Claude Code 2.1.285、サブスクのOAuth認証(APIキーなし)、macOS。2026-10-08 に実験して確認した。

## 1. 防御の層

| 層 | 何を防ぐか | どこで効かせるか |
|---|---|---|
| 1. 権限設定(deny / allow) | push・PR作成・リモート操作、worktree外への Edit/Write、シークレットの Read | 実行ごとに生成する `--settings` の JSON |
| 2. `pre-push` フック | 層1をすり抜けた `git push` | エージェントのworktreeだけに効くフック |
| 3. 認証情報を渡さない | トークンやSSH鍵を使った外部への書き込み | 環境変数の許可リスト、`sandbox.credentials` |
| 4. サンドボックス | Bash の書き込み範囲、読み取りの禁止、通信先 | `--settings` の `sandbox` |

`git push --no-verify` は層2を飛ばせるが、層1(deny)と層4(github.com への通信の遮断)で止まる。

## 2. このリポジトリ(agent-crew 自身)を開発するとき

- `.claude/settings.json`: push系・`gh`・remoteの変更・`core.hooksPath` の変更を deny、シークレットの読み取りを deny、再帰的な削除と `sudo` を ask
- `githooks/pre-push`: 環境変数 `CLAUDECODE`(Claude Code のセッション内)か `AGENT_CREW_RUN`(agent-crew が起動したエージェント)があるときだけ失敗する。人が自分のターミナルから行う push は止めない。Claude Code の中で `! git push` と打った場合も止まる
- clone 後に `scripts/install-hooks.sh` を1回実行する(`core.hooksPath=githooks`)
- 検査: `sh scripts/verify-safety.sh`

## 3. エージェントの起動の標準形

`src/runner/` で必ず次の形に組み立てる。ここから外れる起動方法は作らない。

```
cwd = <タスクのworktree>(~/.agent-team/worktrees/... の下)
env = 許可リストの環境変数だけ(4章)
claude -p
  --setting-sources ""             # user / project / local の設定ファイルを読まない
  --strict-mcp-config              # .mcp.json を読まない(--mcp-config も渡さない)
  --settings <実行ごとに生成した JSON>
  --permission-mode dontAsk        # 許可ルールに無いものは全部拒否
  --permission-prompts none        # 確認待ちで止まらない(拒否して続行)
  --tools <役割ごとの道具>
  --model <role.model> [--effort <role.effort>]
  --output-format stream-json --verbose
  --json-schema <役割の判定スキーマ>
  --add-dir <タスクの成果物ディレクトリ>
  --max-budget-usd <上限>
```

### 3.1 各オプションの理由

- `--setting-sources ""`: 対象リポジトリの `.claude/settings.json` のフック・`env`・許可ルールを読まない。あわせてユーザー設定 `~/.claude/settings.json` も読まない。**ユーザー設定には、対話用の広い許可(ホームディレクトリ全体の読み取りなど)や個人のフックが入っていることがあり、エージェントに効かせてはいけないため**
- `--strict-mcp-config`: 対象リポジトリの `.mcp.json` のサーバーが、信頼確認なしで起動されるのを防ぐ
- `--settings` の `disableAllHooks: true`: 念のためフックを全部止める(ユーザー設定だけでは、プロジェクト側の設定で上書きされうるため、CLIから渡す)
- `--bare` は使わない: サブスクのOAuthが使えなくなる(APIキーが必須)。上の組み合わせで、`--bare` が止める対象のうち安全に関わるもの(フック、`.mcp.json`、設定)は止まる
- 対象リポジトリの `CLAUDE.md` は読み込まれる。規約として有用なので許容する。ただし外から指示を注入される経路にもなるため、会社のリポジトリでは、プロファイルを承認するときに人が中身を確認する
- worktreeを `~/.agent-team/worktrees/` に置くのは、(a) 親ディレクトリの `CLAUDE.md` が読み込まれないようにするため、(b) Claude の一時ディレクトリ(`/tmp/claude-<uid>`)の下では、サンドボックスがworktree内への書き込みも拒否したため

### 3.2 実行ごとに生成する `--settings` の形

```jsonc
{
  "disableAllHooks": true,
  "permissions": {
    "deny": [
      "Bash(git push)", "Bash(git push *)", "Bash(git -C * push *)",
      "Bash(gh *)", "Bash(git remote *)", "Bash(git config *)",
      "Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(~/.config/gh/**)",
      "Read(**/.env)", "Read(**/.env.*)"
    ],
    "allow": [
      "Read", "Grep", "Glob", "Bash",
      // 書き込みは絶対パスで、書ける場所だけを許可する(役割の permissions.write による)
      "Edit(//<worktree>/**)", "Write(//<worktree>/**)",
      "Edit(//<成果物ディレクトリ>/**)", "Write(//<成果物ディレクトリ>/**)"
    ]
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,          // サンドボックスが使えなければ起動しない
    "allowUnsandboxedCommands": false,  // CLIから渡すと「管理者必須」になり、リポジトリ側の緩和が無視される
    "filesystem": { "allowWrite": ["<成果物ディレクトリ>"], "denyWrite": [] },
    "network": { "allowedDomains": ["registry.npmjs.org"], "strictAllowlist": true },
    "credentials": {
      "files": [
        { "path": "~/.ssh", "mode": "deny" },
        { "path": "~/.aws", "mode": "deny" },
        { "path": "~/.config/gh", "mode": "deny" }
      ],
      "envVars": [
        { "name": "GITHUB_TOKEN", "mode": "deny" },
        { "name": "GH_TOKEN", "mode": "deny" }
      ]
    }
  }
}
```

- **`"Edit"` や `"Write"` を、パスを付けずに allow にしない。** 実験では、worktree外(`../`)への Write が通ってしまった
- 書き込みの範囲は、役割定義の `permissions.write` で決める

| `permissions.write` | 使う役割 | Edit/Write の allow | サンドボックス(Bash) |
|---|---|---|---|
| `none` | なし(予備) | なし | worktreeを `denyWrite` |
| `artifacts` | プランナー、レビュワー、QA、統合担当、プロジェクト把握担当 | 成果物ディレクトリだけ | worktreeを `denyWrite`、成果物ディレクトリを `allowWrite`。QAとプロジェクト把握担当は、ビルド・テストのためにworktreeへの書き込みを許す |
| `worktree` | 実装者 | worktree+成果物ディレクトリ | 作業ディレクトリ(worktree)はそのまま書ける |

- 許可する通信先は、プロファイルと設定ファイルで足す。GitHub のドメインは許可しない

## 4. 環境変数(認証情報を渡さない)

エージェントのプロセスには、許可リストの変数だけを渡す(`env -i` 相当)。

- 渡す: `PATH`、`HOME`、`USER`、`LANG`、`LC_*`、`TERM`、`TMPDIR`、`SHELL`
- 追加する: `AGENT_CREW_RUN=1`(pre-push の判定用)、`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`(サンドボックスの外のサブプロセスからも認証情報を消す)
- 渡さない(許可リストに無いので、自動的に落ちる): `ANTHROPIC_API_KEY`、`GITHUB_TOKEN`、`GH_TOKEN`、`SSH_AUTH_SOCK`、`AWS_*`、`NPM_TOKEN`、`CLAUDECODE`、`CLAUDE_CODE_*`(親の Claude Code セッションの変数)
- `HOME` を渡すのは、Claude Code がサブスクのOAuth認証(キーチェーン)を読むため。`~/.ssh` などはサンドボックスの `credentials` で読み取りを拒否する

## 5. 対象リポジトリの `pre-push` フック

- 対象リポジトリの `.git/hooks` に置くと、人が普段のチェックアウトから行う push まで止まる。そのため、**エージェントのworktreeだけ**に効かせる
  - `git config extensions.worktreeConfig true`(対象リポジトリのローカル設定を1つ変える。`doctor` で表示する)
  - worktreeごとに `git config --worktree core.hooksPath ~/.agent-team/hooks`
  - `~/.agent-team/hooks/pre-push` は常に失敗する。それ以外のフック(pre-commit など)は、元のフックの場所に中継する
- `.git` 内の `hooks` と `config` は、サンドボックスの中から書き換えられない(保護されたパス)。フックの設置はツール側(サンドボックスの外)で行う
- 検証済み(2026-10-08、ステップ5): deny ルールを外した状態でも、サンドボックスの中から次の操作はすべて拒否された。`git config --worktree core.hooksPath ...`(`config.worktree` をロックできない)、`config.worktree` への直接の追記、`git config core.hooksPath ...`(本体の `.git/config`)、データディレクトリの `hooks/pre-push` の上書き。deny の `Bash(git config *)` は、これに重ねる防御として残す
- 中継先の決め方: リポジトリ本体の設定(`<git-common-dir>/config`)の `core.hooksPath`(husky など)があればそこ、無ければ `<git-common-dir>/hooks`。ユーザーのグローバル設定の `core.hooksPath` は中継しない

## 6. 実験の記録(2026-10-08)

補足: `claude -p` は標準入力が閉じていないと、3秒待ってから警告を出して進む。ランナーは標準入力を閉じて起動する。


一時ディレクトリにgitリポジトリとworktreeを作り、3.2の設定で `claude -p --model haiku` を実行した。

| 試したこと | 結果 |
|---|---|
| リポジトリ側の `.claude/settings.json` の SessionStart フック | 実行されない ✓ |
| worktree内での書き込みと `git commit` | 成功 ✓ |
| Bash で `../outside.txt` に書く | サンドボックスが拒否 ✓ |
| Write ツールで `../outside2.txt` に書く(パス付きの allow) | 許可ルールで拒否 ✓(パス無しの `"Write"` だと通ってしまった ✗) |
| `ls ~/.ssh` | 拒否 ✓ |
| `echo $GITHUB_TOKEN`(親の環境では値あり) | 空 ✓ |
| `curl https://github.com` | 許可リストに無いため 403 ✓ |
| `curl https://registry.npmjs.org/` | 200 ✓ |
| `git push origin task1` | deny ルールで拒否。`permission_denials` に記録 ✓ |
| `.git/hooks/pre-push` への書き込み | 拒否 ✓ |
| `--json-schema` による判定の受け取り | `structured_output` に、スキーマどおりの値が入る ✓ |

モバイルQAの道具(フェーズ6で対応):

| コマンド | 結果 | 必要になりそうな許可 |
|---|---|---|
| `xcodebuild -version` | 成功 | なし |
| `xcrun simctl list` | CoreSimulatorService に接続できない | `network.allowMachLookup`(CoreSimulator 系)。だめなら `excludedCommands: ["xcrun simctl *"]` |
| `flutter --version` | SDKのキャッシュに書けない | `filesystem.allowWrite`: Flutter SDK の `bin/cache` |
| DerivedData・CoreSimulator・`~/.pub-cache` への書き込み | 拒否 | `filesystem.allowWrite` に各パス |
| `curl https://pub.dev` | 許可リストに無い | `allowedDomains`: `pub.dev`、`storage.googleapis.com` など |

ステップ6で `agent-crew doctor --probe-sandbox` を作り、この実験をいつでも再実行できるようにする。
