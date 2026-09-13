// Display helpers. Everything here is presentation only — no data lives here.

export function pad2(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtCompact(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + " 萬";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return "" + Math.round(n);
}

/** total minutes of a day → HH:MM */
export function hhmm(totalMin: number): string {
  const m = ((Math.round(totalMin) % 1440) + 1440) % 1440;
  return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);
}

/** "2026-09-11 10:37:22" → "10:37" (already GMT+8 in the data) */
export function tsHHMM(ts: string): string {
  const m = /(\d{2}):(\d{2})/.exec(ts.slice(11));
  return m ? `${m[1]}:${m[2]}` : ts;
}

/** seconds → "3 分 12 秒" */
export function fmtElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} 秒`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} 分 ${pad2(s)} 秒`;
}

// ---------- dates (everything the dashboard shows is GMT+8) ----------

export interface DayInfo {
  key: string; // YYYY-MM-DD
  startMs: number;
  dow: number; // 0=Sun
  labelFull: string; // 2026年9月11日
  labelShort: string; // 09/11
  weekday: string; // 週五
  rel: string; // 今天 / 昨天 / N 天前
  isToday: boolean;
  nowMin: number; // minutes into the day, meaningful only when isToday
}

const WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

/** The clock the data lives on: GMT+8, wherever the browser happens to be. */
export function nowInGmt8(): Date {
  const now = new Date();
  return new Date(now.getTime() + 480 * 60000);
}


/** offset 0 = today, -1 = yesterday … always in GMT+8. */
export function dayInfoForOffset(offset: number): DayInfo {
  const now = nowInGmt8();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  const isToday = offset === 0;
  const rel = offset === 0 ? "今天" : offset === -1 ? "昨天" : offset === -2 ? "前天" : `${-offset} 天前`;
  return {
    key: `${y}-${pad2(m)}-${pad2(dd)}`,
    startMs: d.getTime(),
    dow: d.getUTCDay(),
    labelFull: `${y}年${m}月${dd}日`,
    labelShort: `${pad2(m)}/${pad2(dd)}`,
    weekday: WEEKDAYS[d.getUTCDay()],
    rel,
    isToday,
    nowMin: isToday ? now.getUTCHours() * 60 + now.getUTCMinutes() : 1440,
  };
}

/** "2026-09-11 10:37:22" is already GMT+8; these read it without re-parsing zones. */
export function msOfDay(ts: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ts);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
}

/** "10 分鐘前" · "3 小時前" · "09/10 22:14" */
export function agoLabel(ts: string, nowMs: number): string {
  const ms = msOfDay(ts);
  if (ms === null) return ts;
  const diff = Math.round((nowMs - ms) / 1000);
  if (diff < 60) return "剛剛";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小時前`;
  return `${ts.slice(5, 10)} ${ts.slice(11, 16)}`;
}
