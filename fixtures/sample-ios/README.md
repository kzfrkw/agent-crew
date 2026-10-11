# sample-ios

agent-crew の通し確認(フェーズ6b、`npm run e2e:ios`)に使う小さなネイティブ iOS(SwiftUI)アプリ。注文の一覧を表示する。

- 単体テスト: `OrdersTests`。画面の撮影: `OrdersUITests/ScreensUITests`(画面を開いて、画面の ID の名前でスクリーンショットを添付する)
- Xcode 16 以降の「フォルダを同期する」形式のプロジェクト。ターゲットのフォルダに Swift のファイルを置けばビルドに入る
- テスト: `xcodebuild test -scheme Orders -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build/DerivedData -only-testing:OrdersTests`
