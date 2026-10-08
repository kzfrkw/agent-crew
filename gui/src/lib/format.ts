/** 表示用の整形(副作用なし) */

const pad = (n: number) => String(n).padStart(2, "0");

/** ローカル時刻の HH:MM:SS */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 今日なら HH:MM、それ以外は M/D HH:MM */
export function formatDateTime(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const today = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === today.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function formatDuration(sec: number | null): string {
  if (sec === null) return "-";
  const s = Math.round(sec);
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
  return `${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分`;
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "-";
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

export function elapsedSec(startIso: string, now = Date.now()): number {
  return Math.max(0, Math.round((now - Date.parse(startIso)) / 1000));
}
