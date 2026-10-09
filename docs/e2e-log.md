# 一周の通し確認の記録(npm run e2e)

## 2026-10-07T23:25:01.191Z(モデル: sonnet、引き継ぎあり)

- 所要時間: 13分
- 費用(見積もり)の合計: $0.679

| 役割 | モデル | 回数 | 費用 | 秒 |
|---|---|---|---|---|
| profiler | sonnet | 1 | $0.068 | 18 |
| planner | sonnet | 1 | $0.091 | 25 |
| implementer | sonnet | 1 | $0.093 | 22 |
| verifier | haiku | 2 | $0.038 | 17 |
| reviewer | sonnet | 2 | $0.151 | 608 |
| qa | sonnet | 2 | $0.15 | 39 |
| integrator | sonnet | 1 | $0.088 | 20 |

- ✓ タスクが完了
- ✓ 成果物 plan
- ✓ 成果物 impl-notes
- ✓ 成果物 review
- ✓ 成果物 qa-report
- ✓ 成果物 pr-draft
- ✓ ローカルブランチ
- ✓ remote に push されていない
- ✓ エージェントのコミットに trailer
- ✓ 人のコミットを区別

コミット:
- 在庫0のアイテムを一覧APIから除外する(agent-crew implementer)
- docs: 一覧の仕様を README に追記(E2E Human)

観察(2026-10-08): reviewer の合計時間が 608 秒と長かった(2回分)。作業ディレクトリを消したため原因は未調査。次回は `E2E_KEEP=1` で残し、`runs/<id>/stream.jsonl` で、終わらないコマンドや待機が無かったかを確認する。

## 2026-10-08T22:55:58.797Z(モデル: sonnet、引き継ぎあり)

- 所要時間: 3分
- 費用(見積もり)の合計: $0.825

| 役割 | モデル | 回数 | 費用 | 秒 |
|---|---|---|---|---|
| profiler | sonnet | 1 | $0.078 | 15 |
| planner | sonnet | 1 | $0.118 | 28 |
| implementer | sonnet | 1 | $0.122 | 27 |
| verifier | haiku | 2 | $0.063 | 26 |
| reviewer | sonnet | 2 | $0.148 | 22 |
| qa | sonnet | 2 | $0.163 | 38 |
| integrator | sonnet | 1 | $0.133 | 18 |

- ✓ タスクが完了
- ✓ 成果物 plan
- ✓ 成果物 impl-notes
- ✓ 成果物 review
- ✓ 成果物 qa-report
- ✓ 成果物 pr-draft
- ✓ ローカルブランチ
- ✓ remote に push されていない
- ✓ エージェントのコミットに trailer
- ✓ 人のコミットを区別

コミット:
- 一覧APIから在庫0のアイテムを除外する(agent-crew implementer)
- docs: 一覧の仕様を README に追記(E2E Human)


観察(2026-10-09): GUI(`agent-crew serve`)を並べて確認した。reviewer は2回で合計22秒で、前回のような長時間化は再現しなかった。

## 2026-10-09 GUI だけで一周(フェーズ3、モデル: sonnet、停止あり)

準備(サンプルの用意、`project add` / `project approve`)だけ CLI で行い、以降は `serve` の GUI だけで操作した。

- チケット投入(フォーム)→ 常駐ワーカーがすぐ計画 → GUI で計画を承認 → 実装者の実行中に GUI で停止 → GUI で回答して再開 → レビュー・QA → GUI で最終承認 → 統合 → 完了
- 停止: 実装者の実行は「中止」(13秒、$0.080)、タスクは人の回答待ちに。claude のプロセスは残らなかった。worktree に残った書きかけ(未コミットのテストの変更)は、再開した実装者が引き継いで1つのコミットにまとめた
- タスクの費用の合計: $0.633(プロジェクト把握担当を除く)、役割の時間の合計 148秒
- ✓ ローカルブランチ(agent-crew/1-0)、✓ remote に push されていない、✓ エージェントのコミットに trailer
- 気づいたこと: ブラウザ操作(Claude in Chrome)のクリックが送信ボタンに届かないことが1回あった(GUI 側の問題ではない。座標で押し直して送信できた)
