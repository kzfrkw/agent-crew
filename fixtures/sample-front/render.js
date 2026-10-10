// 注文の一覧の画面(HTML を組み立てるだけ。データは API から受け取る)
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function renderOrders(orders) {
  const rows = orders.map((o) => `<tr><td>${esc(o.id)}</td><td>${esc(o.item)}</td><td>${esc(o.quantity)}</td></tr>`).join("");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>注文</title>
<style>body{font-family:sans-serif;margin:16px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style></head>
<body><h1>注文</h1><table><thead><tr><th>ID</th><th>品目</th><th>数量</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}
