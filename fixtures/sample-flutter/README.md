# sample-flutter

agent-crew の通し確認(フェーズ6、`npm run e2e:mobile`)に使う小さな Flutter アプリ。注文の一覧を表示する。

- テスト: `flutter test`、静的解析: `flutter analyze`
- 画面の撮影: `integration_test/screens_test.dart`(agent-crew が iOS シミュレータで動かす)
- iOS のプロジェクト(`ios/`)はリポジトリに入れていない。使う前に `flutter create --platforms ios --org dev.agentcrew .` で作る(e2e のスクリプトが行う)
