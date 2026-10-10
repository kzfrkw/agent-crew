import 'package:flutter/material.dart';

import 'orders.dart';

void main() => runApp(const SampleApp());

class SampleApp extends StatelessWidget {
  const SampleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: '注文',
        theme: ThemeData(colorSchemeSeed: Colors.indigo),
        darkTheme: ThemeData(colorSchemeSeed: Colors.indigo, brightness: Brightness.dark),
        home: const OrdersPage(),
      );
}

/// 注文の一覧の画面
class OrdersPage extends StatelessWidget {
  const OrdersPage({super.key});

  @override
  Widget build(BuildContext context) {
    final orders = listOrders();
    return Scaffold(
      appBar: AppBar(title: const Text('注文の一覧')),
      body: ListView.separated(
        itemCount: orders.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final o = orders[i];
          return ListTile(
            leading: Text('#${o.id}'),
            title: Text(o.item),
            trailing: Text('${o.quantity} 個'),
          );
        },
      ),
    );
  }
}
