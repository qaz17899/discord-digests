// Which reports have been read. The reader queue lives in the browser, so this
// is localStorage-backed; it never needs to reach the server.

const KEY = "watchtower:read-reports";

type Store = Record<string, number>; // report name → unix seconds read

let cache: Store | null = null;
const listeners = new Set<() => void>();

function load(): Store {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(next: Store) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode: the read state is cosmetic, never fail loudly.
  }
  listeners.forEach((fn) => fn());
}

export function isRead(name: string): boolean {
  return !!load()[name];
}

export function markRead(name: string): boolean {
  const cur = load();
  if (cur[name]) return false;
  persist({ ...cur, [name]: Math.floor(Date.now() / 1000) });
  return true;
}

export function markUnread(name: string) {
  const cur = { ...load() };
  delete cur[name];
  persist(cur);
}

export function markAllRead(names: string[]) {
  const cur = { ...load() };
  let changed = false;
  for (const n of names) {
    if (!cur[n]) {
      cur[n] = Math.floor(Date.now() / 1000);
      changed = true;
    }
  }
  if (changed) persist(cur);
  return changed;
}

/** Subscribe to read-state changes (used to refresh unread counters). */
export function onReadChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function unreadCount(names: string[]): number {
  const cur = load();
  return names.filter((n) => !cur[n]).length;
}
