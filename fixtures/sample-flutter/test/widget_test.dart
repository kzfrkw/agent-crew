import 'package:flutter_test/flutter_test.dart';
import 'package:sample_flutter/main.dart';
import 'package:sample_flutter/orders.dart';

void main() {
  test('注文は3件', () {
    expect(listOrders().map((o) => o.item), ['りんご', 'みかん', 'ぶどう']);
  });

  testWidgets('注文の一覧に品目と数量を表示する', (tester) async {
    await tester.pumpWidget(const SampleApp());
    expect(find.text('注文の一覧'), findsOneWidget);
    expect(find.text('りんご'), findsOneWidget);
    expect(find.text('3 個'), findsOneWidget);
  });
}
