# ルーブリック(判定の基準。設計メモ v0.22)

判定する役割が、項目ごとに合否と根拠(成果物のどこか)を返すための基準です。人が書いて直します。コーディネーターや判定する役割は書き換えません。

- ファイル名: 企画の段は `planning-<段>.md`(research / strategy / scope / ux / handoff)。開発の判定役(reviewer、qa、design_reviewer)の分は 10-4 で足す
- 形式: 先頭の frontmatter に `name`(ファイル名と同じ)と `description`。本文の各項目は `- [must] ID: 項目` か `- [should] ID: 項目`(ID はファイルの中で重複しない英大文字と数字)。項目以外の行は説明として読み飛ばす
- 項目は測れる形で書く(「〜がある」「すべて〜」「1つ以上」)。1ファイル10項目以内、must を1つ以上
- must の不合格が1つでもあれば差し戻し(`changes_requested`)。should は記録だけ
