# 導入手順(別のPCへ)

agent-crew を新しい Mac に入れて、最初のプロジェクトを登録するまで。会社のリポジトリを扱う前に、[会社で使う前の点検表](company-checklist.md)も済ませる。

## 1. 前提

| 道具 | 必須か | 確かめ方 |
|---|---|---|
| macOS | 必須(サンドボックスに sandbox-exec を使う) | — |
| Node.js 24 LTS 以上 | 必須 | `node -v` |
| git | 必須 | `git --version` |
| Claude Code(サブスクでログイン済み) | 必須 | `claude --version`、`claude auth status` |
| Google Chrome | 画面の撮影(Web)に使う | `/Applications/Google Chrome.app` |
| Xcode と iOS シミュレータ | ネイティブ iOS・Flutter の QA に使う | `xcodebuild -version`、`xcrun simctl list runtimes` |
| Flutter | Flutter の QA に使う | `flutter --version` |

足りないものは `doctor` が知らせ、使えない機能だけを無効にして動く。

**`ANTHROPIC_API_KEY` は設定しない**(設定されていると API の従量課金になる。`doctor` が警告する)。

## 2. 入れる

```sh
git clone <このリポジトリ> agent-crew
cd agent-crew
npm install                   # GUI のビルドも行われる(prepare)
sh scripts/install-hooks.sh   # このリポジトリの pre-push フックを有効にする
npm test                      # 全テストが通ること(数分)
npx agent-crew doctor         # 前提の検査。エラー(✗)が無いこと
```

## 3. 設定(任意)

設定とデータはリポジトリの外、`~/.agent-team/` に置く(`AGENT_CREW_HOME` で変えられる)。設定ファイルは `~/.agent-team/config.json`。項目は `config.example.json` を参照。よく変えるもの:

- `roles.<役割>.model`: 役割ごとのモデル(例: プランナーだけ opus)
- `concurrency`: 同時に進めるタスクの数(1〜2)。2 にしても、変更するファイルが重なるタスクは先のタスクが終わるまで実装を待つ(フェーズ8)。利用枠の消費は速くなる
- `limits.pauseAtUtilization`: 利用枠の使用率がこれ以上なら自動で一時停止(既定 0.95)
- `notify`: 人の対応待ちを macOS の通知で知らせる(既定 true)
- `sandbox.allowedDomains`: エージェントが通信してよいドメイン(既定は registry.npmjs.org)

## 4. 安全設定の実機検査

```sh
npx agent-crew doctor --probe-sandbox   # claude -p を haiku で1回動かす(数セント)
```

すべて ✓ になること。push の拒否、worktree 外への書き込みの拒否、資格情報が見えないこと、読ませないパスが読めないこと、などを確かめる。Claude Code を更新したときも実行する。

## 5. 最初のプロジェクト

```sh
npx agent-crew project add <リポジトリのパス> --name <名前>   # プロジェクト把握担当がプロファイルを作る
npx agent-crew project show <名前>                           # コマンドを確かめ、必要なら project set で直す
npx agent-crew project protect <名前> --add <パス>           # 読ませないパス(鍵、本番の設定など)
npx agent-crew project approve <名前>
npx agent-crew serve                                          # http://127.0.0.1:4300/ を開き、チケットを投入する
```

## 6. 通し確認(任意。利用枠を使う)

同梱のサンプルで一周させて、新しいPCで最後まで動くことを確かめる。結果は `docs/e2e-log.md` に追記される。

```sh
npm run e2e           # Web(Node のサンプル)
npm run e2e:multi     # 複数リポジトリ
npm run e2e:mobile    # Flutter(Xcode と Flutter が要る)
npm run e2e:ios       # ネイティブ iOS(Xcode が要る)
```
