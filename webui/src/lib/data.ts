// The data layer: it turns the discordwatch API into the shapes the views
// render. Nothing in here invents data — every field either comes from the
// server or is a display-time derivation of one (a colour, a label, a ratio).

import { useEffect, useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  api, type ApiAttachment, type ApiChannelStatus, type ApiEvent, type ApiEventKind,
  type ApiMessage, type ApiReport, type ApiSummary,
} from "./api";
import { dayInfoForOffset, nowInGmt8, type DayInfo } from "./format";

export type { ApiEventKind };

// ------------------------------------------------------------------ types

export interface Author {
  id: string;
  name: string; // the nickname the channel saw
  tag: string; // @username, when we know it
  hue: number;
  bot: boolean;
}

export interface Attachment {
  kind: "image" | "file";
  url: string | null; // null when the CDN link is gone
  filename: string;
  expired: boolean;
  w: number;
  h: number;
}

export interface Reaction {
  e: string;
  n: number;
}

export interface ReplyRef {
  idx: number; // -1 when the replied-to message is not in this day
  name: string;
  excerpt: string;
}

export interface Message {
  idx: number;
  id: string;
  ts: string; // "2026-09-11 10:37:22"
  tsMs: number;
  minute: number; // minute of day
  author: Author;
  content: string;
  edited: boolean;
  deleted: boolean;
  embeds: { title?: string; url?: string; desc?: string; image?: string }[];
  replyTo: ReplyRef | null;
  reactions: Reaction[];
  attachments: Attachment[];
}

export interface EventEvidence {
  idx: number;
  id: string;
  author: Author;
  ts: string;
  content: string;
  reactions: number;
}

export interface EventItem {
  id: string;
  kind: ApiEventKind;
  title: string;
  desc: string;
  startMin: number;
  endMin: number;
  keywords: string[];
  msgCount: number;
  reactionTotal: number;
  authors: number;
  links: number;
  importance: number;
  peakIdx: number;
  peakMin: number;
  evidence: EventEvidence[];
}

export interface AuthorStat {
  author: Author;
  count: number;
}

export interface DomainStat {
  domain: string;
  count: number;
}

export interface Stats {
  peakHour: number;
  coldHour: number;
  peakMinLabel: string;
  peakMinCount: number;
  topAuthors: AuthorStat[];
  mostReplied: AuthorStat[];
  mostReacted: AuthorStat[];
  topDomains: DomainStat[];
}

export interface MediaItem {
  idx: number;
  ts: string;
  author: Author;
  att: Attachment;
}

export interface Digest {
  name: string; // report file name
  markdown: string; // report body
  inputName: string; // prepared input file name, "" when there is none
  coverage: number; // messages the report claims to cover
}

export interface ChannelDef {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  watching: boolean;
}

export interface ChannelDay {
  def: ChannelDef;
  info: DayInfo;
  key: string; // `<channelId>|<YYYY-MM-DD>`
  count: number;
  prevCount: number;
  ratio: number;
  hourly: number[];
  peakHour: number;
  coldHour: number;
  events: EventItem[];
  maxImportance: number;
  topKeywords: string[];
  hasDigest: boolean;
  hasInput: boolean;
  digest: Digest;
  stats: Stats;
  authors: Author[];
  media: MediaItem[];
  messages: Message[];
  links: number;
  reactions: number;
  firstTs: string;
  lastTs: string;
}

/** What the status wall needs: a summary, no messages. */
export interface ChannelCard {
  key: string;
  id: string;
  name: string;
  typeLabel: string;
  watching: boolean;
  info: DayInfo;
  count: number;
  prevCount: number;
  ratio: number;
  allTimeTotal: number;
  hourly: number[];
  events: EventItem[];
  maxImportance: number;
  topKeywords: string[];
  hasDigest: boolean;
  lastTs: string;
}

// ------------------------------------------------------------------ identity

const TYPE_LABELS: Record<string, string> = {
  text: "文字頻道",
  thread: "討論串",
  forum: "論壇",
  voice: "語音頻道",
  announcement: "公告頻道",
  stage: "舞台頻道",
};

export function typeLabel(t: string): string {
  return TYPE_LABELS[t] ?? t ?? "頻道";
}

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const authorCache = new Map<string, Author>();

/** One identity per person, stable colours, bots flagged by their name. */
function authorOf(name: string, username?: string, id?: string): Author {
  const key = id || username || name;
  const hit = authorCache.get(key);
  if (hit) return hit;
  const a: Author = {
    id: key,
    name: name || username || "unknown",
    tag: username ? "@" + username : "",
    hue: hashStr(key) % 360,
    bot: /(^|[^a-z])bot([^a-z]|$)|bot$/i.test(username ?? "") || /bot$/i.test(name),
  };
  authorCache.set(key, a);
  return a;
}

// ------------------------------------------------------------------ mapping

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

/**
 * Discord signs every CDN link with ?ex=<hex unix time>. Once that moment has
 * passed the link is dead until a bot token re-signs it, so the wall can tell
 * without loading a single byte.
 */
function signatureExpired(url: string): boolean {
  const ex = /[?&]ex=([0-9a-f]+)/i.exec(url);
  if (!ex) return false;
  return parseInt(ex[1], 16) * 1000 < Date.now();
}

function attachmentOf(a: ApiAttachment, fresh: Record<string, string>): Attachment {
  const url = fresh[a.url] || a.url || "";
  const isImage = (a.type ?? "").startsWith("image/") || IMAGE_EXT.test(a.filename ?? "");
  return {
    kind: isImage ? "image" : "file",
    url: url || null,
    filename: a.filename || "(未命名檔案)",
    expired: !url || signatureExpired(url),
    w: a.width ?? 0,
    h: a.height ?? 0,
  };
}

function toMessage(rec: ApiMessage, idx: number, fresh: Record<string, string>, byId: Map<string, number>): Message {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(rec.ts);
  const minute = m ? +m[4] * 60 + +m[5] : 0;
  const tsMs = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]) : 0;

  let replyTo: ReplyRef | null = null;
  if (rec.reply_to_id || rec.reply || rec.reply_username) {
    const targetIdx = rec.reply_to_id ? byId.get(rec.reply_to_id) : undefined;
    // The referenced message may live in an earlier day; then all we have is its
    // author's name, and no excerpt.
    replyTo = { idx: targetIdx ?? -1, name: rec.reply || rec.reply_username || "未知", excerpt: "" };
  }

  return {
    idx,
    id: rec.id,
    ts: rec.ts,
    tsMs,
    minute,
    author: authorOf(rec.author, rec.username, rec.author_id),
    content: rec.content ?? "",
    edited: !!rec.edited,
    deleted: !!rec.deleted,
    embeds: (rec.embeds ?? []).map((e) => ({ title: e.title, url: e.url, desc: e.desc, image: e.image })),
    replyTo,
    reactions: (rec.reactions ?? [])
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((r) => ({ e: r.emoji, n: r.count })),
    attachments: (rec.attachments ?? []).map((a) => attachmentOf(a, fresh)),
  };
}

function ratioOf(count: number, prevCount: number): number {
  if (prevCount <= 0) return count > 0 ? 1 : 0;
  return (count - prevCount) / prevCount;
}

function toEvents(events: ApiEvent[], msgs: Message[], byId: Map<string, number>): EventItem[] {
  return events.map((ev) => {
    const evidence: EventEvidence[] = ev.evidence.map((e) => {
      const idx = byId.get(e.id);
      const m = idx === undefined ? undefined : msgs[idx];
      return {
        idx: idx ?? -1,
        id: e.id,
        author: m?.author ?? authorOf(e.author),
        ts: e.ts,
        content: e.content,
        reactions: e.reactions,
      };
    });
    return {
      id: ev.id,
      kind: ev.kind,
      title: ev.title,
      desc: ev.desc,
      startMin: ev.startMin,
      endMin: ev.endMin,
      keywords: ev.keywords ?? [],
      msgCount: ev.messages,
      reactionTotal: ev.reactions,
      authors: ev.authors,
      links: ev.links,
      importance: ev.importance,
      peakIdx: byId.get(ev.peakId) ?? evidence[0]?.idx ?? -1,
      peakMin: ev.peakMin,
      evidence,
    };
  });
}

function keywordRollup(events: EventItem[]): string[] {
  const seen: string[] = [];
  for (const ev of events) {
    for (const k of ev.keywords) {
      if (!seen.includes(k)) seen.push(k);
    }
  }
  return seen.slice(0, 3);
}

// ------------------------------------------------------------------ hooks

export interface Overview {
  cards: ChannelCard[];
  channels: ApiChannelStatus[];
  llmConfigured: boolean;
  mediaRefresh: boolean;
  generatedAt: string;
  loading: boolean;
  error: string | null;
}

/**
 * The collector's own state, polled with TanStack Query.
 */
export function useLiveStatus(intervalMs = 10000): { channels: ApiChannelStatus[]; error: string | null } {
  const query = useQuery({
    queryKey: ["liveStatus"],
    queryFn: () => api.status(),
    refetchInterval: intervalMs,
    staleTime: 5000,
  });

  return {
    channels: query.data?.channels ?? [],
    error: query.error ? String(query.error instanceof Error ? query.error.message : query.error) : null,
  };
}

/**
 * The status wall's query: one summary per channel plus the collector's own
 * state. TanStack Query automatically keeps previous data during transitions.
 */
export function useOverview(dayOffset: number, refreshNonce = 0): Overview {
  const info = useMemo(() => dayInfoForOffset(dayOffset), [dayOffset]);

  const query = useQuery({
    queryKey: ["overview", info.key, refreshNonce],
    queryFn: async () => {
      const [overview, status] = await Promise.all([
        api.overview(info.key, info.key, refreshNonce > 0),
        api.status(),
      ]);
      return { overview, status };
    },
    placeholderData: keepPreviousData,
    refetchInterval: info.isToday ? 15000 : false,
    staleTime: 5000,
  });

  return useMemo(() => {
    const data = query.data;
    if (!data) {
      return {
        cards: [],
        channels: [],
        llmConfigured: false,
        mediaRefresh: false,
        generatedAt: "",
        loading: query.isLoading,
        error: query.error ? String(query.error instanceof Error ? query.error.message : query.error) : null,
      };
    }
    const totals = new Map(data.status.channels.map((c) => [c.id, c]));
    const cards = data.overview.channels.map((s) => toCard(s, info, totals.get(s.channelId)?.total ?? 0));
    return {
      cards,
      channels: data.status.channels,
      llmConfigured: data.overview.llmConfigured,
      mediaRefresh: data.overview.mediaRefresh,
      generatedAt: data.overview.generatedAt,
      loading: query.isPlaceholderData || query.isLoading,
      error: query.error ? String(query.error instanceof Error ? query.error.message : query.error) : null,
    };
  }, [query.data, query.isLoading, query.isPlaceholderData, query.error, info]);
}

function toCard(s: ApiSummary, info: DayInfo, allTimeTotal: number): ChannelCard {
  const msgs: Message[] = [];
  const events = toEvents(s.events ?? [], msgs, new Map());
  return {
    key: `${s.channelId}|${info.key}`,
    id: s.channelId,
    name: s.name,
    typeLabel: typeLabel(s.type),
    watching: s.watching,
    info,
    count: s.count,
    prevCount: s.prevCount,
    ratio: ratioOf(s.count, s.prevCount),
    allTimeTotal,
    hourly: s.hourly ?? new Array(24).fill(0),
    events,
    maxImportance: events.reduce((m, e) => Math.max(m, e.importance), 0),
    topKeywords: keywordRollup(events),
    hasDigest: !!s.report,
    lastTs: s.lastTs,
  };
}

export interface ChannelView {
  day: ChannelDay | null;
  loading: boolean;
  error: string | null;
}

/**
 * One channel, one day. The messages are fetched whole: a day is the unit of
 * work here, and the tab that shows them virtualizes the list anyway.
 */
export function useChannelDay(channelId: string, dayOffset: number, refreshNonce = 0): ChannelView {
  const info = useMemo(() => dayInfoForOffset(dayOffset), [dayOffset]);

  const query = useQuery({
    queryKey: ["channelDay", channelId, info.key, refreshNonce],
    queryFn: async () => {
      const [summary, messages] = await Promise.all([
        api.summary(channelId, info.key, info.key, refreshNonce > 0),
        api.messages(channelId, info.key, info.key),
      ]);
      const report = summary.report ? await api.report(summary.report) : "";
      return { summary, messages, report };
    },
    placeholderData: keepPreviousData,
    refetchInterval: info.isToday ? 15000 : false,
    staleTime: 5000,
  });

  const day = useMemo(() => {
    const data = query.data;
    if (!data || query.isPlaceholderData) return null;
    const { summary, messages, report } = data;
    const recs = [...messages.messages].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
    const byId = new Map<string, number>();
    recs.forEach((r, i) => byId.set(r.id, i));
    const msgs = recs.map((r, i) => toMessage(r, i, messages.freshMedia ?? {}, byId));

    // Replies that point at a message inside this day get an excerpt.
    for (const m of msgs) {
      if (m.replyTo && m.replyTo.idx >= 0) {
        const target = msgs[m.replyTo.idx];
        m.replyTo.name = target.author.name;
        m.replyTo.excerpt = (target.content || "(附件)").replace(/\s+/g, " ").slice(0, 60);
      }
    }

    const events = toEvents(summary.events ?? [], msgs, byId);

    // Leaderboards are counted from the messages themselves, so every name on
    // them carries the same identity (and colours) as the stream below.
    const authors = new Map<string, Author>();
    const talk = new Map<string, number>();
    const replied = new Map<string, number>();
    const reacted = new Map<string, number>();
    const media: MediaItem[] = [];
    for (const m of msgs) {
      authors.set(m.author.id, m.author);
      talk.set(m.author.id, (talk.get(m.author.id) ?? 0) + 1);
      const total = m.reactions.reduce((a, r) => a + r.n, 0);
      if (total > 0) reacted.set(m.author.id, (reacted.get(m.author.id) ?? 0) + total);
      if (m.replyTo) {
        const target = m.replyTo.idx >= 0 ? msgs[m.replyTo.idx] : null;
        const id = target ? target.author.id : m.replyTo.name;
        if (target) authors.set(id, target.author);
        replied.set(id, (replied.get(id) ?? 0) + 1);
      }
      for (const att of m.attachments) {
        if (att.kind === "image") media.push({ idx: m.idx, ts: m.ts, author: m.author, att });
      }
    }
    /** 媒體圖片牆預設新的在上；訊息本體維持舊到新（依照時間軸瀏覽）。 */
    media.reverse();
    const board = (counts: Map<string, number>): AuthorStat[] =>
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([id, count]) => ({ author: authors.get(id) ?? authorOf(id), count }));

    const stats: Stats = {
      peakHour: summary.peakHour,
      coldHour: summary.coldHour,
      peakMinLabel: summary.peakMinute,
      peakMinCount: summary.peakMinuteCount,
      topAuthors: board(talk),
      mostReplied: board(replied),
      mostReacted: board(reacted),
      topDomains: (summary.topDomains ?? []).map((d) => ({ domain: d.key, count: d.count })),
    };

    return {
      def: {
        id: summary.channelId,
        name: summary.name,
        type: summary.type,
        typeLabel: typeLabel(summary.type),
        watching: summary.watching,
      },
      info,
      key: `${summary.channelId}|${info.key}`,
      count: summary.count,
      prevCount: summary.prevCount,
      ratio: ratioOf(summary.count, summary.prevCount),
      hourly: summary.hourly ?? new Array(24).fill(0),
      peakHour: summary.peakHour,
      coldHour: summary.coldHour,
      events,
      maxImportance: events.reduce((m, e) => Math.max(m, e.importance), 0),
      topKeywords: keywordRollup(events),
      hasDigest: !!summary.report,
      hasInput: !!summary.reportInput,
      digest: { name: summary.report, markdown: report, inputName: summary.reportInput, coverage: summary.count },
      stats,
      authors: [...authors.values()],
      media,
      messages: msgs,
      links: summary.links,
      reactions: summary.reactions,
      firstTs: summary.firstTs,
      lastTs: summary.lastTs,
    } satisfies ChannelDay;
  }, [query.data, query.isPlaceholderData, info]);

  return {
    day,
    loading: query.isLoading || query.isPlaceholderData,
    error: query.error ? String(query.error instanceof Error ? query.error.message : query.error) : null,
  };
}

// ------------------------------------------------------------------ helpers

const searchCache = new WeakMap<ChannelDay, string[]>();

/** Lowercased "author content" per message, built once per day. */
export function searchIndex(day: ChannelDay): string[] {
  const hit = searchCache.get(day);
  if (hit) return hit;
  const arr = day.messages.map((m) => (m.author.name + " " + m.content).toLowerCase());
  searchCache.set(day, arr);
  return arr;
}

// ------------------------------------------------------------------ reports

/** One archived report, with the channel's display name resolved. */
export interface ReportItem {
  name: string;
  channelId: string;
  channelName: string;
  day: string; // YYYY-MM-DD, "" for an all-history report
  range: string; // "HH:MM-HH:MM" when the report covers part of a day
  whole: boolean;
  size: number;
  modified: string;
  label: string; // "09/10" or "全部"
  weekday: string;
  offset: number; // days from today, so "go to that day" works
}

/** The channel's reports, newest first — the archive list in the digest tab and
 *  the reading queue both come from here. */
export function useReports(refreshNonce = 0): { items: ReportItem[]; loading: boolean; error: string | null; reload: () => void } {
  const channels = useOverview(0, 0).channels;

  const query = useQuery({
    queryKey: ["reports", refreshNonce],
    queryFn: () => api.reports(),
    staleTime: 10000,
  });

  const items = useMemo<ReportItem[]>(() => {
    const rows = query.data ?? [];
    const nameOf = new Map(channels.map((c) => [c.id, c.name]));
    const today = dayInfoForOffset(0);
    return rows.map((r) => {
      const info = r.day ? dayInfoFromKey(r.day) : null;
      const offset = info ? Math.round((info.startMs - today.startMs) / 86400000) : 0;
      return {
        name: r.name,
        channelId: r.channelId,
        channelName: nameOf.get(r.channelId) ?? r.channelId,
        day: r.day,
        range: r.range,
        whole: r.whole,
        size: r.size,
        modified: r.modified,
        label: info ? info.labelShort : "全部",
        weekday: info ? info.weekday : "",
        offset,
      };
    });
  }, [query.data, channels]);

  return {
    items,
    loading: query.isLoading,
    error: query.error ? String(query.error instanceof Error ? query.error.message : query.error) : null,
    reload: () => { void query.refetch(); },
  };
}

/** A `YYYY-MM-DD` key turned back into the calendar info the views use. */
function dayInfoFromKey(key: string): DayInfo | null {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return null;
  const target = Date.UTC(y, m - 1, d);
  const today = nowInGmt8();
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return dayInfoForOffset(Math.round((target - base) / 86400000));
}

/** Fetch one report's markdown. */
export function useReportBody(name: string | null): { markdown: string; loading: boolean; error: string | null } {
  const query = useQuery({
    queryKey: ["reportBody", name],
    queryFn: () => (name ? api.report(name) : Promise.resolve("")),
    enabled: !!name,
    staleTime: 60000,
  });

  return {
    markdown: query.data ?? "",
    loading: query.isLoading,
    error: query.error ? String(query.error instanceof Error ? query.error.message : query.error) : null,
  };
}
