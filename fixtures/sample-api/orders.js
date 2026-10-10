// 注文のデータ(サンプルのため、メモリの中だけ)
const orders = [
  { id: 1, item: "りんご", quantity: 3 },
  { id: 2, item: "みかん", quantity: 1 },
  { id: 3, item: "ぶどう", quantity: 2 },
];

export function listOrders() {
  return orders.map((o) => ({ ...o }));
}

export function findOrder(id) {
  const o = orders.find((x) => x.id === id);
  return o ? { ...o } : undefined;
}
