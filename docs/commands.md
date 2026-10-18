# コマンドと運用の手順

`CLAUDE.md` から移した、人がツールを使うときの手順と、開発で使うコマンドの一覧です。コードを書くときに守る決まりは `CLAUDE.md` に残しています。設計の理由は `docs/design-memo.md` を参照してください。

## コマンド

- clone後に1回: `sh scripts/install-hooks.sh`(pre-pushフックを有効にする)
- 安全設定の検査: `sh scripts/verify-safety.sh`
- セットアップ: `npm install`(Node 24 LTS以上。ビルド工程は無く、TypeScriptをNodeの型除去で直接実行する)
- テスト: `npm test`(vitest)
- 型チェック: `npm run typecheck`(tsc --noEmit)。まとめて `npm run check`
- CLI: `npx agent-crew --help`(または `./bin/agent-crew.js`)
- 前提の検査: `npx agent-crew doctor`(`--json` 可。エラーがあれば終了コード1)。データディレクトリは `~/.agent-team`(`AGENT_CREW_HOME` で変更可)
- 安全設定の実機検査: `npx agent-crew doctor --probe-sandbox`(claude -p を haiku で1回動かす。利用枠を少し使う。ランナーや安全設定を変えたら必ず実行する)
- 基本の流れ: `project add <path> --name <n>` → `project approve <n>` → `task create --project <n> --title ... --body-file ...` → `run` → `task approve <id> --kind plan` → `run` → `task approve <id> --kind final` → `run`。人の対応待ちは `task list`(★)と `task show <id>`
- プロファイルのコマンドの手直し: `project set <n> --start "..." --test "..."`(役割に渡すコマンドの正本は DB。`profile.md` を手で直しても反映されない。`-` で「なし」。`project show` とプロジェクト画面で確認できる)
- 報告(API を使わない書き戻し): `task report <id>` で Notion などに貼る Markdown を出す(概要・受け入れ条件・QA・デザインレビュー・PR の下書き)。取り込み元の URL は `task create --source-url` で持たせる。投稿は人が行う
- 読ませないパス: `project protect <n> --add <相対パス>`(鍵・本番の設定など。エージェントの Read / Bash とツールの実行のどれからも読めない。`project show` で確認)
- 利用枠: 使用率が `limits.pauseAtUtilization`(既定 0.95)以上になると、常駐ワーカーと `run` は新しい役割を起動せず、リセットの後に再開する。GUI のヘッダーに使用率。人の対応待ちは macOS の通知(`notify`)。完了・取り消しのタスクの worktree は自動で片付く(ブランチは残る)
- 自律(フェーズ8): 小さなタスクの計画の自動承認は `project set <n> --auto-approve-plan on`(既定 off)。大きいチケットはプランナーが分割を提案し、`task approve <id> --kind plan --split` で子タスクに分けて順に進める。同じ理由の差し戻しが2回続くと人に回る。完了したタスクは振り返り(`task retro <id> --adopt <番号>` で採用。`project set <n> --retrospective off` で止める)
- 企画(フェーズ9): 新サービスは `project create <n>`(リポジトリなし)、既存サービスの新機能はそのプロジェクトで `task plan --project <n> --title ... --body ... --docs <絶対パス>`(GUI のチケット作成で「企画として作る」も可)。調査 → 戦略 → 要件 → 構造・骨格 → 引き渡しの順に、書く役と批評担当が進める。人の承認は `task approve <id> --kind strategy|scope|handoff`(引き渡しは `--target <開発のプロジェクト>`。新サービスは `--repo <フォルダ>` で企画のプロジェクトにリポジトリを登録するか、`--new-project <名前>` を足して別のプロジェクトを作る。空のフォルダなら git init する。GUI の引き渡しの欄でも選べ、プロファイルはプロジェクトの画面で承認する)。承認待ちに「人の判断が要る点」があれば承認のコメントで答える。批評担当は段ごとのルーブリック(`rubrics/planning-<段>.md`)の項目ごとに合否を返し、must の不合格があれば差し戻す(基準を変えるときはこのファイルを直す)。通し確認は `npm run e2e:planning`
- コーディネーター(フェーズ10): 企画を LLM のコーディネーターで進めるには `task plan ... --coordinator`(タスクごと)か `project set <n> --coordinator on`(新しい企画の既定。`--fixed` で固定の流れ)。状態は「進行中(コーディネーター)」になり、一手ごとに `coordinator-log.md` に残る。許されない一手(関門を飛ばす、ルーブリックの must が不合格のまま進めるなど)はツールが却下し、2回続くと人の回答待ち。1タスクあたりの上限は `limits.maxRunsPerTask` / `limits.maxCostPerTaskUsd`。固定の流れとの比較は `E2E_FLOW=coordinator npm run e2e:planning`(結果は docs/e2e-log.md に、止まった回数・差し戻し・人の介入・must の初回の合格つきで残る)
- 導入: `docs/setup.md`(別のPC)、`docs/company-checklist.md`(会社で使う前の点検表)
- デザインレビューで止まったとき(撮影できないなど): `task skip-design-review <id>`(飛ばして最終確認へ)か `task back-to-implementer <id> --comment ...`(GUI の人の判断待ちの欄にも出る)。デザイナーが `uiChanges: false` を返したタスクとテスト基盤整備では、デザインレビューを行わない
- 人への引き継ぎ: `task takeover <id>` → worktree で作業してコミット → `task return <id>`。ベースへの追従: `task update-base <id>`(タスクのコミットがまだ無ければ、今の既定ブランチから作り直す。共通の祖先が無い履歴にも追従できる)
- GUI: `npx agent-crew serve`(http://127.0.0.1:4300/ 。常駐ワーカーがタスクを自動で進め、GUI から承認・回答・停止・引き取り・チケット投入ができる。`--no-worker` で読み取り専用。GUI のビルドが無いか古ければ自動でビルドする。`--no-build` で抑止)。CLI の `run` とはロックで排他する(GUI で一時停止すると CLI の run を使える)
- GUI のビルド: `npm run build:gui`(`npm install` 時にも `prepare` で実行される。結果は `dist/gui/`)
- GUI の開発: `npx agent-crew serve` を起動したうえで `npm run dev:gui`(Vite。`/api` と `/files` を 4300 に中継。`AGENT_CREW_PORT` で変更可)
- GUI の見本データ: `AGENT_CREW_HOME=<空のディレクトリ> node scripts/seed-demo.ts`(claude を使わずに全状態のタスクを作る。claudePath を /usr/bin/false にするので、常駐ワーカーが動いても利用枠は使わない)
- shadcn/ui の部品の追加: `node scripts/shadcn-add.ts <名前...>`(公式レジストリから `gui/src/components/ui/` に置く。shadcn の CLI は GUI を `gui/` に分けた構成に合わないため使わない)。追加したら `docs/surface.md` の原則(影なし、状態の4色)に合わせて直す。画面のコードに色や px の値を直接書かない(トークン経由の Tailwind のクラスを使う)
- サンドボックスに依存するテスト(`sandbox-exec` の撮影、プロセスの片付け)は、エージェントのサンドボックスの中(`AGENT_CREW_RUN=1`)では飛ばす(`tests/helpers/env.ts`)。人の環境の `npm test` では必ず実行される
- GUI のテスト: `gui/src/**/*.test.{ts,tsx}`(vitest。DOM が要るものは先頭に `// @vitest-environment jsdom`)
- 一周の通し確認: `npm run e2e`(実機の claude を使う。利用枠を消費する。結果は docs/e2e-log.md)。複数リポジトリは `npm run e2e:multi`(同梱の sample-api と sample-front)、Flutter は `npm run e2e:mobile`、ネイティブ iOS は `npm run e2e:ios`(同梱の sample-ios)
- Flutter(フェーズ6): 把握担当が `pubspec.yaml` から種類を flutter にする(`project set <n> --platform flutter --analyze "flutter analyze"` でも直せる)。Flutter のテスト・解析はツールが sandbox-exec で代わりに実行し、エージェントには MCP の道具 `run_project_command` だけを渡す(`agent-crew mcp-exec` は内部用)。画面は `integration_test/screens_test.dart` をツール専用のシミュレータ `agent-crew-<番号>` で動かして撮る(機種は config.json の `simulatorDevice`)。通し確認は `npm run e2e:mobile`(同梱の sample-flutter。Xcode・iOS シミュレータ・Flutter が要る)
- 複数リポジトリ: `project add-repo <n> <path> --role <役目>` → `project wire <n> --role frontend --env API_URL={origin:backend}`(起動のつなぎ方。{url:} は確認 URL そのまま、{origin:} はパスを除いたもの、{port:} はポート)
- **agent-crew のエージェント(このリポジトリを対象に動く役割)は、`npm run e2e` と `doctor --probe-sandbox` を実行しない**(実機の claude を使うため、人が実行する)。テストは `npm test`、型チェックは `npm run typecheck` で確かめる
- TypeScriptの制約: 型除去で動く構文だけを使う(`enum`・`namespace`・パラメータプロパティは不可。importは `.ts` 拡張子付き)

## 実行方式と課金・認証

- ワーカーは `claude -p`(ヘッドレス実行)に決定。呼び出しは `src/runner/` に閉じ込め、後からAgent SDKに差し替えられるようにする
- **サブスク(Pro/Max)の範囲で動かす前提。** 追加課金が発生するのは、追加利用(extra usage)をオンにしたときと、`ANTHROPIC_API_KEY` が設定されているとき
- **`ANTHROPIC_API_KEY` を設定しない。** `doctor` は設定されていたら警告する
- `--bare` はAPIキー専用でサブスクでは使えない。安全設定は `--bare` に頼らず、ツール側から渡す設定・deny・フックで効かせる。エージェントの起動の標準形(`--setting-sources ""`、`--strict-mcp-config`、実行ごとの `--settings`)は `docs/safety.md` を参照
- `--bare` なしの `-p` は、対象リポジトリの `.claude/settings.json` のフックや `.mcp.json` を信頼確認なしで実行する。会社のリポジトリを扱うときは注意する
- 利用枠はチャットや対話利用と共有される。同時実行数は1〜2から始め、消費ペースを見て調整する
- 仕様(利用枠、課金)は変わりやすい。実装前に最新の公式ドキュメントを確認する

## ディレクトリ構成(想定)

```
.
├── CLAUDE.md
├── docs/
│   └── design-memo.md      # 設計メモ(正本)
├── roles/                  # 役割定義(Markdown。frontmatterに model / permissions / outputs)
├── rubrics/                # 判定の基準(ルーブリック。人が書いて直す。形式は rubrics/README.md)
├── src/
│   ├── orchestrator/       # 状態遷移(固定。フェーズ10でコーディネーターの一手の検証に移す)、役割の起動、上限管理
│   ├── runner/             # Claude Codeのヘッドレス実行のラッパー
│   ├── db/                 # SQLiteスキーマとアクセス
│   ├── cli/                # CLIエントリポイント、doctor
│   └── server/             # ローカルサーバー(読み取りAPI、SSE、GUIの配信)。api-types.ts はGUIと共有
├── gui/                    # GUI(React + Vite)。ビルド結果は dist/gui/(リポジトリに入れない)
├── config.example.json     # 設定のサンプル(実設定はリポジトリ外)
└── .claude/
    └── settings.json       # 権限設定(pushの禁止など)
```

## 技術スタック(初期の想定。確定したら更新する)

- サーバー: Node.js(24 LTS以上)+ TypeScript(Nodeの型除去で直接実行)
- GUI: React + Vite、shadcn/ui + Tailwind CSS v4 + Radix UI(部品と使い分けは `docs/surface.md`)
- DB: SQLite(Node組み込みの `node:sqlite`)
- リアルタイム配信: SSE
- 役割定義: `roles/*.md`(1ファイル1役割)
