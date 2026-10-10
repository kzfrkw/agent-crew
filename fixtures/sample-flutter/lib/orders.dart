/// 注文(画面に出すデータ)。サンプルなので固定の値を返す
class Order {
  const Order({required this.id, required this.item, required this.quantity});

  final int id;
  final String item;
  final int quantity;
}

List<Order> listOrders() => const [
      Order(id: 1, item: 'りんご', quantity: 3),
      Order(id: 2, item: 'みかん', quantity: 1),
      Order(id: 3, item: 'ぶどう', quantity: 2),
    ];
