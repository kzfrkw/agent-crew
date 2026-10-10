// 画面を撮るテスト(agent-crew がシミュレータで動かし、ライト / ダークで撮る)。
// 画面を開くたびに shot('<画面の ID>') を呼ぶ
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sample_flutter/main.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  /// 描き終えてから撮る。iOS は画面の描画が1フレーム遅れることがあり、
  /// すぐに撮ると起動直後の「Test starting...」が写ることがある(agent-crew の e2e で発見)
  Future<void> shot(WidgetTester tester, String name) async {
    await tester.pumpAndSettle();
    await Future<void>.delayed(const Duration(milliseconds: 800));
    await tester.pump();
    await binding.takeScreenshot(name);
  }

  testWidgets('screens', (tester) async {
    await tester.pumpWidget(const SampleApp());
    await binding.convertFlutterSurfaceToImage();
    await shot(tester, 's1-orders');
  });
}
