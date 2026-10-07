// 在庫アイテムのデータと操作
const items = [
  { id: 1, name: "りんご", stock: 3 },
  { id: 2, name: "みかん", stock: 0 },
  { id: 3, name: "ぶどう", stock: 12 },
];

export function listItems() {
  return items.map((i) => ({ ...i }));
}

export function findItem(id) {
  const item = items.find((i) => i.id === id);
  return item ? { ...item } : undefined;
}
