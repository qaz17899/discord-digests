// The wire types of the discordwatch API, and the only place that talks HTTP.
// GET /api/status · /api/overview · /api/channels/{id}/{summary,messages,stats,input,lab}
// GET /api/reports · /api/reports/{name} · /api/jobs/{id} · /api/settings · /api/schedule
// POST /api/channels/{id}/digest · /api/media/refresh · /api/settings/test
// PUT /api/settings · /api/schedule

export interface ApiReport {
  name: string;
  channelId: string;
  day: string; // YYYY-MM-DD, empty for an all-history report
  range: string; // HH:MM-HH:MM, empty for a full day
  whole: boolean;
  size: number;
  modified: string; // GMT+8 "YYYY-MM-DD HH:MM:SS"
}

export interface ApiAttachment {
  filename: string;
  url: string;
  type?: string;
  width?: number;
  height?: number;
  size?: number;
}

export interface ApiEmbed {
  title?: string;
  desc?: string;
  url?: string;
  image?: string;
}

export interface ApiReaction {
  emoji: string;
  count: number;
}

/** One line of all.jsonl, already merged and reaction-tallied by the server. */
export interface ApiMessage {
  id: string;
  ts: string; // "2026-09-11 10:37:22" (GMT+8)
  channel: string;
  author: string; // server nickname, what the channel saw
  username?: string;
  author_id?: string;
  content: string;
  reply?: string; // nickname of the replied-to author
  reply_username?: string;
  reply_to_id?: string;
  attachments?: ApiAttachment[];
  embeds?: ApiEmbed[];
  reactions?: ApiReaction[];
  edited?: string;
  deleted?: boolean;
}

export interface ApiMessages {
  channelId: string;
  from: string;
  to: string;
  total: number;
  count: number;
  messages: ApiMessage[];
  /** attachment url → freshly signed url, when a refresh has already happened */
  freshMedia: Record<string, string>;
  generatedAt: string;
}

export interface ApiEvidence {
  id: string;
  author: string;
  ts: string;
  content: string;
  reactions: number;
}

export interface ApiEvent {
  id: string;
  kind: ApiEventKind;
  title: string;
  desc: string;
  startMin: number;
  endMin: number;
  messages: number;
  reactions: number;
  authors: number;
  links: number;
  keywords: string[];
  importance: number;
  score: number;
  peakId: string;
  peakMin: number;
  evidence: ApiEvidence[];
}

export type ApiEventKind =
  | "debate" | "announce" | "raid" | "drop" | "outage"
  | "release" | "ama" | "milestone" | "spike";

export interface TopEntry {
  key: string;
  count: number;
}

export interface ApiSummary {
  channelId: string;
  name: string;
  type: string;
  guildId: string;
  watching: boolean;
  from: string;
  to: string;
  count: number;
  prevCount: number;
  authors: number;
  media: number;
  reactions: number;
  links: number;
  hourly: number[];
  peakHour: number;
  coldHour: number;
  peakMinute: string;
  peakMinuteCount: number;
  topAuthors: TopEntry[];
  topReplied: TopEntry[];
  topReacted: TopEntry[];
  topDomains: TopEntry[];
  events: ApiEvent[];
  report: string;
  reportInput: string;
  firstTs: string;
  lastTs: string;
}

export interface ApiOverview {
  from: string;
  to: string;
  channels: ApiSummary[];
  generatedAt: string;
  llmConfigured: boolean;
  mediaRefresh: boolean;
}

export interface ApiChannelStatus {
  id: string;
  name: string;
  type: string;
  guildId: string;
  lastTs: string;
  total: number;
  watching: boolean;
}

export interface ApiStatus {
  channels: ApiChannelStatus[];
  session: { userId: string; resumeUrl: string; seq: number };
  watch: ApiWatch;
  llmConfigured: boolean;
  mediaRefresh: boolean;
  now: string;
}

/** Is the collector process alive? A stale heartbeat file means it was killed. */
export interface ApiWatch {
  online: boolean;
  pid: number;
  at: string;
  channels: number;
  received: number;
  connected: boolean;
}

/** One finished (channel, day) unit of a history fetch. */
export interface ApiBackfillDay {
  day: string;
  added: number;
  updated: number;
  skipped: number;
  pages: number;
  ms: number;
  err?: string;
}

/** A chain currently fetching one day. */
export interface ApiBackfillCurrent {
  channel: string;
  day: string;
  pages: number;
  added: number;
  updated: number;
  skipped: number;
}

export interface ApiBackfillTotals {
  units: number;
  done: number;
  added: number;
  updated: number;
  skipped: number;
  pages: number;
  errors: number;
  msgsPerMin: number;
  etaMin: number;
}

export type ApiBackfillState = "request" | "running" | "done" | "error" | "cancelled";

/** A REST history fetch. Queued by the dashboard, executed by the collector. */
export interface ApiBackfillJob {
  id: string;
  state: ApiBackfillState;
  channels: string[];
  from: string;
  to: string;
  totals: ApiBackfillTotals;
  done?: Record<string, Record<string, ApiBackfillDay>>;
  current?: ApiBackfillCurrent[];
  message?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
}

export interface ApiJob {
  id: string;
  channelId: string;
  from: string;
  to: string;
  state: "running" | "done" | "input" | "error";
  message: string;
  batches: number;
  done: number;
  report: string;
  started: string;
  finished: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, init);
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      if (body?.error) detail = body.error;
    } catch {
      /* the body was not json; the status is all we have */
    }
    throw new Error(detail);
  }
  return resp.json() as Promise<T>;
}

function dayQuery(from: string, to: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({ from, to, ...extra }).toString();
}

function channelPath(channelId: string, leaf: string) {
  return `/api/channels/${encodeURIComponent(channelId)}/${leaf}`;
}

export const api = {
  status: () => request<ApiStatus>("/api/status"),

  overview: (from: string, to: string, refresh = false) =>
    request<ApiOverview>(`/api/overview?${dayQuery(from, to, refresh ? { refresh: "1" } : {})}`),

  summary: (channelId: string, from: string, to: string, refresh = false) =>
    request<ApiSummary>(`${channelPath(channelId, "summary")}?${dayQuery(from, to, refresh ? { refresh: "1" } : {})}`),

  messages: (channelId: string, from: string, to: string) =>
    request<ApiMessages>(`${channelPath(channelId, "messages")}?${dayQuery(from, to)}`),

  report: (name: string) =>
    fetch(`/api/reports/${encodeURIComponent(name)}`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }),

  reports: () => request<ApiReport[]>("/api/reports"),

  deleteReport: (name: string) =>
    request<{ removed: string[] }>(`/api/reports/${encodeURIComponent(name)}`, { method: "DELETE" }),

  startDigest: (channelId: string, from: string, to: string) =>
    request<ApiJob>(`${channelPath(channelId, "digest")}?${dayQuery(from, to)}`, { method: "POST" }),

  job: (id: string) => request<ApiJob>(`/api/jobs/${encodeURIComponent(id)}`),
  jobs: () => request<ApiJob[]>("/api/jobs"),

  refreshMedia: (channelId: string, urls: string[]) =>
    request<{ urls: Record<string, string>; failed: string[] }>(channelPath(channelId, "media/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    }),

  settings: () => request<ApiSettings>("/api/settings"),
  saveSettings: (body: SettingsPatch) =>
    request<ApiSettings>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  testSettings: (body: { what: "llm" | "bot"; apiKey?: string; botToken?: string }) =>
    request<{ llm?: ProbeResult; bot?: ProbeResult }>("/api/settings/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  /** Everything the digest workbench shows for one window, from real data. */
  lab: (channelId: string, from: string, to: string, full = false) =>
    request<ApiLab>(
      `${channelPath(channelId, "lab")}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${full ? "&full=1" : ""}`,
    ),

  schedule: () => request<ApiScheduleState>("/api/schedule"),

  saveSchedule: (body: ApiSchedule) =>
    request<ApiScheduleState>("/api/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  /** Confirm a channel id against Discord before adding it to the watch list. */
  resolve: (id: string) => request<ApiResolved>("/api/resolve?id=" + encodeURIComponent(id)),

  /** History fetches: the dashboard queues them, the collector runs them. */
  backfills: () => request<ApiBackfillJob[]>("/api/backfill"),

  backfill: (id: string) => request<ApiBackfillJob>(`/api/backfill/${encodeURIComponent(id)}`),

  startBackfill: (channels: string[], from: string, to: string) =>
    request<ApiBackfillJob>("/api/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels, from, to }),
    }),

  cancelBackfill: (id: string) =>
    request<ApiBackfillJob>(`/api/backfill/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
};

export interface ApiLab {
  channelId: string;
  name?: string;
  from: string;
  to: string;
  range?: string;
  empty?: boolean;
  messages: number;
  authors?: number;
  links?: number;
  media?: number;
  reactions?: number;
  hourly: number[];
  peakHour?: number;
  peakMinute?: string;
  peakMinuteCount?: number;
  events?: ApiEvent[];
  compressedChars?: number;
  batches?: number;
  maxChars?: number;
  prompts?: { system: string; user: string; reduce: string; userTemplate: string; userChars: number; userLines: number; truncated: boolean };
  tokens?: { system: number; user: number; body: number; perBatch: number; estimated: boolean };
  /** 實際送出的訊息則數；等於 messages（全部送出，沒有抽樣） */
  included?: number;
}

export interface ApiSchedule {
  enabled: boolean;
  mode: "daily" | "interval";
  time: string;
  intervalH: number;
  weekdaysOnly: boolean;
  offsetDays: number;
  targets: string[] | null;
}

export interface ApiScheduleState {
  schedule: ApiSchedule;
  nextRun: string;
  lastNote: string;
  recent: { key: string; day: string; channelId: string; at: string }[] | null;
}

export interface ApiResolved {
  id: string;
  name: string;
  type: number;
  guildId: string;
  watching: boolean;
}

/** Secrets are write-only: the server sends back only whether they exist. */
export interface ApiSettings {
  llm: {
    baseUrl: string; model: string; maxChars: number; apiKeySet: boolean; apiKeyTag: string;
    apiKeyEnv: boolean;
    temperature: number | null; maxTokens: number;
  };
  prompts: { system: string; user: string; reduce: string };
  defaultPrompts: { system: string; user: string; reduce: string };
  schedule: ApiSchedule;
  botTokenSet: boolean;
  botTokenTag: string;
  botTokenEnv: boolean;
  userTokenSet: boolean;
  watch: string[];
  home: string;
  defaultMaxChars: number;
  defaultScheduleTime: string;
}

export interface SettingsPatch {
  llm: {
    baseUrl: string; model: string; maxChars: number; apiKey: string;
    temperature?: number; maxTokens?: number;
  };
  botToken: string;
  prompts?: { system: string; user: string; reduce: string };
  watch?: string[];
  clearApiKey?: boolean;
  clearBotToken?: boolean;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}
