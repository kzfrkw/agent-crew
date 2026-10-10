// 画面を撮るテスト(agent-crew がシミュレータで動かし、ライト / ダークで撮る)。
// 画面を開くたびに takeScreenshot('<画面の ID>') を呼ぶ
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sample_flutter/main.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('screens', (tester) async {
    await tester.pumpWidget(const SampleApp());
    await binding.convertFlutterSurfaceToImage();
    await tester.pumpAndSettle();
    await binding.takeScreenshot('s1-orders');
  });
}
