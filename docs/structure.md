# 構造(GUI・フェーズ2)

要件は `docs/scope.md`。

## 画面一覧

| ID | 画面 | URL | 機能 |
|----|------|-----|------|
| S1 | ダッシュボード | `/` | F1 対応待ち、F2 実況、F3 タスク一覧 |
| S2 | タスク詳細 | `/tasks/:id` | F4、F9 |
| S3 | 成果物ビューア | `/tasks/:id/artifacts/:artifactId` | F5 |
| S4 | 実行ログ | `/runs/:id` | F6 |
| S5 | プロジェクト | `/projects/:id` | F7 |

すべての画面に共通ヘッダー(ロゴ、プロジェクトへの切り替え、SSE の接続状態、「読み取り専用」の表示)を置く。

## 画面遷移

```mermaid
flowchart LR
  S1[S1 ダッシュボード] -->|対応待ち/一覧の行| S2[S2 タスク詳細]
  S1 -->|実況の行| S4[S4 実行ログ]
  S1 -->|プロジェクト名| S5[S5 プロジェクト]
  S2 -->|成果物| S3[S3 成果物ビューア]
  S2 -->|実行の行| S4
  S2 -->|プロジェクト名| S5
  S3 -->|元の実行| S4
  S3 -->|タスクへ| S2
  S4 -->|タスクへ| S2
  S4 -->|成果物| S3
  S5 -->|タスク| S2
  S5 -->|プロファイル作成の実行| S4
```

## データモデル(読み取りAPI)

正本は SQLite(設計メモ12章)。GUI はサーバーの読み取り専用 JSON API だけを使う。型は `src/server/api-types.ts` に置き、サーバーと GUI で共有する(フェーズ3で書き込みAPIを足すときも同じ型を使う)。

| API | 返すもの | 使う画面 |
|-----|----------|----------|
| `GET /api/overview` | プロジェクト一覧、タスクの要約(状態、実行中の役割、対応待ちの理由、費用の合計)、実行中の実行 | S1 |
| `GET /api/projects/:id` | プロジェクト、プロファイル、リポジトリ、`decisions.md` の本文、プロジェクト把握担当の実行、タスクの要約 | S5 |
| `GET /api/tasks/:id` | タスク、worktree、承認(有効/失効)、成果物、実行の一覧、費用と時間の合計、対応待ちの理由、次の CLI コマンド | S2 |
| `GET /api/artifacts/:id` | 成果物のメタ情報と本文(テキストなら)、画像なら `/files/` のURL | S3 |
| `GET /api/runs/:id` | 実行のメタ情報(役割、モデル、状態、判定、要約、エラー、費用、時間)と、生ログのURL | S4 |
| `GET /api/events?after=&task=&run=&limit=` | イベント(id 昇順)。`after` 以降だけを返す | S1, S2, S4 |
| `GET /api/stream`(SSE) | `change`(タスク・実行が変わった)と `events`(新しいイベント)を送る | 全画面 |
| `GET /files/<相対パス>` | 成果物の置き場所のファイル(既存。`tasks/` `projects/` `runs/` 以外は配信しない) | S3, S4 |

### 要約の主な項目

- タスクの要約: `id`, `projectId`, `title`, `kind`, `state`, `heldFromState`, `assignee`, `reviewRounds`, `updatedAt`, `attention`(対応待ちの種類: `approve_plan` / `approve_final` / `answer` / `failed` / `human_working` / なし), `reason`(回答待ちの質問・失敗の理由), `running`(実行中の役割とモデル、開始時刻)
- 次の CLI コマンド(F9)はサーバー側で状態から組み立てる(状態とコマンドの対応はオーケストレーターの知識なので、GUI に持たせない)

### 即時反映(SSE)

- オーケストレーター(`agent-crew run`)は別のプロセスで DB に書く。サーバーは DB を1秒ごとに見て、`events` の最大 id と、`tasks` / `runs` の更新の印が変わったら通知する
- `events` は `after` 以降を送り、GUI は表示中のリストに追記する。`change` を受けた画面は、自分の API を取り直す
- 再接続時は `Last-Event-ID` で取りこぼしを補う

---

# 構造(フェーズ3: 操作)

## 画面の追加

| ID | 画面 | URL | 機能 |
|----|------|-----|------|
| S6 | チケット投入 | `/tasks/new` | G10 |

- S2 タスク詳細の「対応が必要です」の欄が、コマンドの表示からボタンとフォームに変わる(G3〜G9)。CLI コマンドは折りたたんで残す
- S1 ダッシュボードの対応待ちの各項目に、主な操作のボタン(承認・回答など)を置く
- 共通ヘッダーに、自動実行の状態とスイッチ(G1・G2)と「チケットを作る」を置く

## 書き込み API

すべて `POST`、本文は JSON。外部のサイトから送らせないよう、`X-Agent-Crew: 1` ヘッダーと、`Origin` が自分自身であることを必須にする(ヘッダーの付いた要求はブラウザがプリフライトを送るが、CORS を許可しないので外部のサイトからは届かない)。

| API | 本文 | 内容 |
|-----|------|------|
| `POST /api/tasks` | `{ projectId, title, body, sourceUrl? }` | チケット投入。作ったタスクを返す |
| `POST /api/tasks/:id/actions` | `ActionRequest` | 人の操作。`approve`(kind, comment?)/ `reject`(kind, comment)/ `answer`(message)/ `stop` / `takeover` / `return` / `cancel` / `update_base` / `open_editor` |
| `POST /api/worker` | `{ paused: boolean }` | 自動実行の一時停止・再開 |

- 操作は CLI と同じ関数(`src/orchestrator/human.ts`、`handoff.ts`)を呼ぶ。状態遷移の正しさは `transitions.ts` が決め、不正なら 409 と理由を返す
- 「次の操作」(`next-actions.ts`)が、ボタンが送る `ActionRequest` も持つ。GUI は状態とボタンの対応を持たない
- `GET /api/overview` に `worker`(`running` / `paused` / `locked`(CLI の run が実行中)/ `disabled`)を足す

## 常駐ワーカー(G1・G2・G5)

- serve の起動時にロック(`run.lock`)を取り、オーケストレーターを常駐させる。取れなければ(CLI の run が実行中)`locked` として、一定間隔で取り直す
- 進められるタスクを、同時実行数の上限まで進める。操作の直後と、一定間隔(5秒)で見直す(CLI からのチケット投入なども拾う)
- 停止: タスクごとに中断の仕組み(AbortSignal)を持ち、ランナーが claude に SIGINT → SIGTERM → SIGKILL を送る。役割の実行は `cancelled`、タスクは出来事 `stopped` で needs_input になる(状態は増やさない)
- `serve --no-worker` で従来どおり読み取り専用にできる
