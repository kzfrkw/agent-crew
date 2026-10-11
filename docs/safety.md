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
- **権限ルールはパスを文字列で照合し、シンボリックリンクを解決しない**(2026-10-08、ステップ9の実機確認で判明)。実体のパスで許可しても、エージェントが別名(macOS の `/var` → `/private/var` など)で書くと拒否される。ランナーは worktree と成果物ディレクトリについて、実体のパスと指定どおりのパスの両方に許可を出す。データディレクトリも起動時に実体のパスへそろえる
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` を設定すると、権限モードが default に強制される(警告が出る)。`--permission-prompts none` なので確認が必要な操作は拒否され、挙動は変わらない。警告に従い、allow ルールを `--allowedTools` でも明示する
- `--json-schema` には `$schema`(draft 2020-12 の宣言)を含めない。claude の検証器が解釈できずに起動に失敗する
- 書き込みの範囲は、役割定義の `permissions.write` で決める

| `permissions.write` | 使う役割 | Edit/Write の allow | サンドボックス(Bash) |
|---|---|---|---|
| `none` | なし(予備) | なし | worktreeを `denyWrite` |
| `artifacts` | プランナー、レビュワー、監査担当、QA、統合担当、プロジェクト把握担当 | 成果物ディレクトリだけ | worktreeを `denyWrite`、成果物ディレクトリを `allowWrite`。QAとプロジェクト把握担当は、ビルド・テストのためにworktreeへの書き込みを許す |
| `worktree` | 実装者 | worktree+成果物ディレクトリ | 作業ディレクトリ(worktree)はそのまま書ける |

- 許可する通信先は、プロファイルと設定ファイルで足す。GitHub のドメインは許可しない
- `permissions.localServer: true` の役割(実装者、verifier、レビュワー、QA、プロジェクト把握担当)は、`network.allowLocalBinding` と、`localhost` / `127.0.0.1` への接続を許可する。Webアプリのテストはサーバーを 127.0.0.1 で起動して確かめることが多く、許可しないと `listen EPERM` で失敗する(2026-10-08、ステップ10の実機確認で判明)。外部への通信の制限は変わらない
- エージェント用のフック(`<データ>/hooks`)は全worktreeで共有し、`agent-crew run` を始めるたびに最新の内容に書き直す(ツールを更新したとき、既存のworktreeにも効かせるため)

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

`agent-crew doctor --probe-sandbox` で、この実験(push、worktree外への書き込み、`~/.ssh`、環境変数、通信、リポジトリ側のフック、`hooksPath` の書き換え)をいつでも再実行できる。判定はモデルの申告ではなく、ファイル・コミット・remote・拒否の記録で行う。ランナーや安全設定を変えたら必ず実行する。

## 7. 実験の記録: サンドボックスの中のヘッドレス Chrome(2026-10-10、4c の前提)

QA と同じ設定(`write: artifacts`、`bashWritesWorktree`、`localServer`)の `claude -p`(Haiku)に、`/Applications/Google Chrome.app` のヘッドレスでスクリーンショットを撮らせた。

| 試したこと | 結果 |
|---|---|
| 既定の設定 | `Failed to create headless user data directory container`(ホームの下に書けない) |
| `--user-data-dir` を作業ディレクトリに | `ProcessSingleton` のソケットのディレクトリを作れない。macOS の Chrome はソケットを OS のユーザー一時ディレクトリ(`/var/folders/…/T/`)に作り、`TMPDIR` や `HOME` を変えても従わない |
| ユーザー一時ディレクトリへの書き込みを許す | ソケットの `bind()` が拒否される(サンドボックスは Unix ドメインソケットを既定で禁止) |
| さらに `network.allowAllUnixSockets` を許す | Chrome の起動処理の内部(`base/mac/mac_util.mm`)で OS への問い合わせが拒否され、強制終了(FATAL) |

`--no-sandbox`、GPU・crashpad を切る指定でも変わらない。**結論: エージェントのサンドボックスの中で Chrome を動かす方式は採らない。** 許可を広げるほど別の制限に当たり、広げた許可(ユーザー一時ディレクトリへの書き込み、Unix ドメインソケット)は安全上も望ましくない。画面の確認は、サンドボックスの外の、ツールが管理する仕組みで行う(4c で決める)。

### 追記: 画面が消えているときの停止(2026-10-11)

- 画面がスリープしている間は、ヘッドレス Chrome が `CVDisplayLinkCreateWithCGDisplay failed` を出し、DevTools への接続を受け付けたまま応答しないことがある。そのプロセスを `lsof` で調べると `lsof` も止まり、役割の実行の後片付けが進まなくなった(テストが 15 分止まって発見)
- 対策: DevTools への接続に上限(10 秒)、後片付けの `ps` / `lsof` に上限(15 秒。時間切れなら何も止めない)を設けた。撮影に失敗しても、タスクは止まらず、撮れなかった画面として扱われる

## 8. 実験の記録: iOS シミュレータと Flutter(2026-10-11、フェーズ6の前提)

Xcode 26.4、iOS 26.4 のシミュレータ、Flutter 3.41.6 で確認した。

| 確認したこと | 結果 |
|---|---|
| ツールが専用の端末を作って起動(`simctl create` / `boot` / `bootstatus`) | できる。起動 約36秒、再起動 約10秒。Simulator.app は開かない |
| インストール・起動・撮影(`simctl install` / `launch` / `io screenshot`) | できる。1206×2622 の PNG |
| ライト/ダークの切り替え(`simctl ui <端末> appearance dark`) | できる(アプリが darkTheme を持っていれば反映) |
| ディープリンク(`simctl openurl`) | iOS の確認ダイアログが出て、タップしないと進まない |
| 起動時の環境変数(`SIMCTL_CHILD_*`) | `simctl spawn` には届くが、Flutter の `Platform.environment` には届かない |
| `flutter drive` + `integration_test` の `takeScreenshot` | 特定の画面を開いて撮れる。ビルドを含め約28秒 |
| Claude のサンドボックスの中の `flutter pub get --offline` | SDK の `bin/cache` 等への書き込みを許せば動く |
| Claude のサンドボックスの中の `flutter test` | 動かない。キャッシュへの書き込みと 127.0.0.1 の待ち受けを許しても、テストのエンジン(flutter_tester)が読み込みで止まる |
| ツールの sandbox-exec(書き込みは worktree・一時ディレクトリ・Flutter のキャッシュ、通信は localhost、資格情報は読めない)の中の `flutter test` | 2秒で通る |

方針(設計メモ v0.15): Flutter のテスト・解析・撮影はツールが sandbox-exec で代わりに実行し、エージェントには MCP で「決めたコマンドの実行」だけを渡す。`flutter drive` のドライバーはホストで動くため、リポジトリのものではなくツールが用意したものを使う。

### 追記: MCP の橋の実機確認(2026-10-11、6a-3)

- `claude -p --strict-mcp-config --mcp-config <実行ごとの mcp.json>` で、agent-crew の MCP サーバー(`agent-crew mcp-exec`)を渡し、`--allowedTools` と settings の allow に `mcp__agent-crew__run_project_command` だけを足した。haiku で、`flutter pub get`(Bash。Flutter のキャッシュへの書き込みと pub.dev / storage.googleapis.com への通信を足した)→ 橋で `flutter test` → 橋で `flutter analyze` がすべて終了コード 0 で通った($0.04)
- 橋で実行できるのは、ツールが書いた設定ファイルのコマンド(プロファイルのテスト・解析)だけ。実行は sandbox-exec の中(書き込みは worktree と Flutter のキャッシュ、通信は localhost、資格情報は読めない)

### 追記: 撮影(flutter drive)を sandbox-exec で囲う(2026-10-11、6a-4)

- `flutter drive`(Xcode のビルドを含む)を sandbox-exec の中で動かすには、worktree と Flutter のキャッシュのほかに、`~/Library/Developer/Xcode/DerivedData` と、ユーザーの一時ディレクトリ(`getconf DARWIN_USER_TEMP_DIR`)への書き込みが要った。後者は Xcode の actool がそこへ直接書くため(`TemporaryItems` だけでは足りない。`TMPDIR` を変えても効かない)
- ユーザーの一時ディレクトリはほかのアプリの一時ファイルも置かれる場所なので、エージェントのコード(ビルドの処理やテスト)がそこを書き換えられることは受け入れたリスク。ホームの文書や資格情報は読めず、通信は localhost だけのまま
- アプリのシミュレータへのインストールは CoreSimulator のサービスが行うため、`~/Library/Developer/CoreSimulator` への書き込みは許していない
- 実機で、専用の端末 `agent-crew-1` を借りて起動 → ライト / ダークのそれぞれ `flutter drive` → 止めて返す、までを確認した(約37秒。2画面 × 2配色)

## 9. 実験の記録: ネイティブ iOS(SwiftUI)のテストと撮影(2026-10-11、6b の前提)

手で書いた Xcode のプロジェクト(アプリ・単体テスト・UI テスト)で確認した。

| 確認したこと | 結果 |
|---|---|
| sandbox-exec(書き込みは worktree とユーザーの一時ディレクトリ)の中の `xcodebuild test` | ビルドは通るが、テストの実行で testmanagerd の unix ソケット(`/private/var/tmp/com.apple.launchd.*/com.apple.testmanagerd.unix-domain.socket`)への接続が拒否された |
| 上に、そのソケットへの接続だけを許す | 疑似端末(`/dev/ptmx`)の作成が拒否された |
| 上に、`/dev/ptmx` への書き込みを許す | 単体テストと UI テストが通った(約20秒) |
| `-derivedDataPath build/DerivedData` | 共有の DerivedData への書き込みは不要になった(worktree の中に作る) |
| XCUITest の `XCTAttachment(screenshot:)` を `xcresulttool export attachments` で取り出す | 取り出せた。名前(画面の ID)は manifest.json の `suggestedHumanReadableName` の先頭に入る。1206×2622、ステータスバーも写る |

方針(設計メモ v0.16): 種類が ios のプロジェクトだけ、sandbox-exec に testmanagerd のソケットへの接続と `/dev/ptmx` を足す。通信は localhost のまま(unix ソケットは testmanagerd の1つだけ)。
