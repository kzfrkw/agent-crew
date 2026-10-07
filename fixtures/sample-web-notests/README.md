# sample-web

agent-crew の動作確認用の小さな在庫API(依存パッケージなし)。

- 起動: `npm start`(http://127.0.0.1:3000/ 、`PORT` で変更可)
- テスト: (まだ無い)

## API
- `GET /api/items` … アイテムの一覧
- `GET /api/items/:id` … アイテム1件(無ければ404)
