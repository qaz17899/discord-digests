import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft, Hash, Sparkles, CheckCheck, Download, FileText, Zap,
  BarChart3, Users, Image as ImageIcon, ScrollText, TrendingUp, TrendingDown,
  ChevronLeft, ChevronRight, RefreshCw, Loader2,
} from "lucide-react";
import { useChannelDay, useReports } from "@/lib/data";
import { api, type ApiJob } from "@/lib/api";
import { dayInfoForOffset, fmtInt, fmtCompact, agoLabel } from "@/lib/format";
import { DateNav } from "./StatusWall";
import { Chip } from "./ui";
import { DigestTab } from "./tabs/DigestTab";
import { EventsTab } from "./tabs/EventsTab";
import { HeatTab } from "./tabs/HeatTab";
import { PeopleTab } from "./tabs/PeopleTab";
import { MediaTab } from "./tabs/MediaTab";
import { MessagesTab } from "./tabs/MessagesTab";

export type TabId = "digest" | "events" | "heat" | "people" | "media" | "messages";
export interface JumpSignal { idx: number; nonce: number }

interface ChannelRef { id: string; name: string; total: number }

interface WorkspaceProps {
  channelId: string;
  tab: TabId;
  onTab: (t: TabId) => void;
  dayOffset: number;
  onOffset: (n: number) => void;
  onBack: () => void;
  onSwitchChannel: (id: string) => void;
  channels: ChannelRef[];
  readSet: Set<string>;
  onToggleRead: (key: string) => void;
  onRefresh: () => void;
  refreshNonce: number;
  llmConfigured: boolean;
  mediaRefresh: boolean;
  pushToast: (msg: string, kind?: "ok" | "info" | "danger") => void;
  onOpenReport: (channelId: string, dayOffset: number) => void;
}

const TABS: { id: TabId; label: string; icon: typeof FileText }[] = [
  { id: "digest", label: "摘要", icon: FileText },
  { id: "events", label: "事件", icon: Zap },
  { id: "heat", label: "熱度", icon: BarChart3 },
  { id: "people", label: "人物", icon: Users },
  { id: "media", label: "媒體", icon: ImageIcon },
  { id: "messages", label: "原始訊息", icon: ScrollText },
];

export function Workspace(props: WorkspaceProps) {
  const {
    channelId, tab, onTab: setTab, dayOffset, onOffset, onBack, onSwitchChannel, channels,
    readSet, onToggleRead, onRefresh, refreshNonce, llmConfigured, mediaRefresh, pushToast, onOpenReport,
  } = props;
  const info = dayInfoForOffset(dayOffset);
  const { day, loading, error } = useChannelDay(channelId, dayOffset, refreshNonce);
  const { items: reportItems, reload: reloadReports } = useReports();
  /** 這條頻道哪些天有摘要 —— 時間線上的 lime 點。 */
  const reportDays = useMemo(() => {
    const days = new Set<string>();
    for (const r of reportItems) {
      if (r.channelId === channelId && r.day) days.add(r.day);
    }
    return days;
  }, [reportItems, channelId]);

  const [jump, setJump] = useState<JumpSignal | null>(null);
  const [job, setJob] = useState<ApiJob | null>(null);
  const [starting, setStarting] = useState(false);

  const digestReady = !!day?.hasDigest;
  const key = `${channelId}|${info.key}`;
  const isRead = readSet.has(key);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // reset per-day state when channel/date changes (the tab lives in the URL)
  useEffect(() => {
    setJump(null);
    setJob(null);
    setStarting(false);
  }, [channelId, dayOffset]);

  // 摘要工作在 serve 裡跑，切頁只會讓前端忘記它。回來時把同一頻道、同一段
  // 日期、還在跑的工作接回來，進度才不會看起來像重新開始。
  useEffect(() => {
    let alive = true;
    api
      .jobs()
      .then((jobs) => {
        const mine = jobs.find((j) => j.channelId === channelId && j.state === "running" && j.from.startsWith(info.key));
        if (alive && mine) setJob(mine);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [channelId, info.key]);

  // Poll the summarizer job. The server reports real batch progress.
  useEffect(() => {
    if (!job || job.state !== "running") return;
    const t = setInterval(async () => {
      try {
        const next = await api.job(job.id);
        setJob(next);
        if (next.state !== "running") {
          onRefresh();
          pushToast(next.state === "done" ? "摘要已產生" : next.message, next.state === "error" ? "danger" : "ok");
        }
      } catch (err) {
        setJob({ ...job, state: "error", message: String(err instanceof Error ? err.message : err) });
      }
    }, 1500);
    return () => clearInterval(t);
  }, [job, onRefresh, pushToast]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const startGeneration = useCallback(async () => {
    if (starting || job?.state === "running") return;
    setTab("digest");
    setStarting(true);
    try {
      const started = await api.startDigest(channelId, info.key, info.key);
      setJob(started);
      pushToast(started.state === "running" ? "開始產生摘要…" : started.message, "info");
    } catch (err) {
      pushToast(`啟動失敗：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setStarting(false);
    }
  }, [channelId, info.key, job, pushToast, starting]);

  const jumpTo = useCallback((idx: number) => {
    if (idx < 0) {
      pushToast("來源訊息不在這天的範圍內", "danger");
      return;
    }
    setTab("messages");
    setJump({ idx, nonce: Date.now() });
  }, [pushToast]);

  const doExport = useCallback(() => {
    if (!day) return;
    const report = {
      channel: day.def.name,
      channelId: day.def.id,
      date: day.info.key,
      count: day.count,
      prevCount: day.prevCount,
      dayBeforeRatio: +(day.ratio * 100).toFixed(2),
      authors: day.authors.length,
      images: day.media.length,
      links: day.links,
      reactions: day.reactions,
      firstMessage: day.firstTs,
      lastMessage: day.lastTs,
      hourly: day.hourly,
      peakHour: day.peakHour,
      peakMinute: day.stats.peakMinLabel,
      peakMinuteCount: day.stats.peakMinCount,
      topAuthors: day.stats.topAuthors.slice(0, 10).map((a) => ({ name: a.author.name, count: a.count })),
      topReplied: day.stats.mostReplied.slice(0, 10).map((a) => ({ name: a.author.name, count: a.count })),
      topReacted: day.stats.mostReacted.slice(0, 10).map((a) => ({ name: a.author.name, count: a.count })),
      topDomains: day.stats.topDomains,
      events: day.events.map((e) => ({
        kind: e.kind, title: e.title, desc: e.desc, startMin: e.startMin, endMin: e.endMin,
        keywords: e.keywords, messages: e.msgCount, reactions: e.reactionTotal, importance: e.importance,
        evidence: e.evidence.map((v) => ({ author: v.author.name, ts: v.ts, content: v.content })),
      })),
      report: day.digest.name || null,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `watchtower_${day.def.id}_${day.info.key}.json`;
    a.click();
    URL.revokeObjectURL(url);
    pushToast("摘要 JSON 已匯出", "ok");
  }, [day, pushToast]);

  const badgeFor = (id: TabId): string | null => {
    if (!day) return null;
    if (id === "events") return day.events.length ? String(day.events.length) : null;
    if (id === "media") return day.media.length ? String(day.media.length) : null;
    if (id === "messages") return fmtCompact(day.count);
    return null;
  };

  const index = channels.findIndex((c) => c.id === channelId);
  const prev = index >= 0 && channels.length ? channels[(index - 1 + channels.length) % channels.length] : null;
  const next = index >= 0 && channels.length ? channels[(index + 1) % channels.length] : null;

  return (
    <div className="mx-auto max-w-[1200px] px-5 md:px-8 pb-24">
      {/* ---- header ---- */}
      <motion.header
        initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="pt-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={onBack}
              className="group inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-fog transition hover:border-lime/40 hover:text-lime"
            >
              <ArrowLeft size={14} className="transition-transform group-hover:-translate-x-0.5" />
              狀態牆
              <span className="ml-1 hidden rounded border border-white/10 px-1 font-mono text-[9.5px] text-dim sm:inline">ESC</span>
            </button>
            <div className="mx-1 h-4 w-px bg-white/10" />
            <div className="flex items-center gap-1">
              <button
                title={prev ? `上一個頻道 · #${prev.name}` : "上一個頻道"}
                onClick={() => prev && onSwitchChannel(prev.id)}
                disabled={!prev}
                className="grid h-8 w-8 place-items-center rounded-lg border border-white/[0.08] text-dim transition hover:border-lime/40 hover:text-lime disabled:opacity-30"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="font-mono text-[10px] tabular text-dim">
                {index >= 0 ? String(index + 1).padStart(2, "0") : "—"}/{channels.length}
              </span>
              <button
                title={next ? `下一個頻道 · #${next.name}` : "下一個頻道"}
                onClick={() => next && onSwitchChannel(next.id)}
                disabled={!next}
                className="grid h-8 w-8 place-items-center rounded-lg border border-white/[0.08] text-dim transition hover:border-lime/40 hover:text-lime disabled:opacity-30"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
          <DateNav dayOffset={dayOffset} onOffset={onOffset} compact loading={loading} />
        </div>

        <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="grid h-10 w-10 place-items-center rounded-xl border border-white/[0.08] bg-panel2">
                <Hash size={19} className="text-lime" />
              </div>
              <div>
                <h1 className="font-display text-[26px] font-700 leading-none tracking-tight" style={{ fontWeight: 700 }}>
                  {day ? day.def.name : channelId}
                </h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-dim">
                  <span>{day ? day.def.typeLabel : "載入中…"}</span>
                  <span className="text-white/15">|</span>
                  <span className="tabular">{info.labelFull} {info.weekday}</span>
                  {day && (
                    <>
                      <span className="text-white/15">|</span>
                      <span className="tabular text-fog">{fmtInt(day.count)} 則</span>
                      <span className={`inline-flex items-center gap-0.5 font-mono text-[11px] tabular ${day.ratio >= 0 ? "text-lime" : "text-fog"}`}>
                        {day.ratio >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                        {day.ratio >= 0 ? "+" : ""}{(day.ratio * 100).toFixed(1)}%
                      </span>
                      {day.lastTs && <span className="font-mono text-[10.5px] text-dim">最後一則 {agoLabel(day.lastTs, Date.now())}</span>}
                      {day.events.length > 0 && (
                        <Chip tone={day.maxImportance >= 4 ? "danger" : "amber"}>
                          <Zap size={10} />{day.events.length} 事件
                        </Chip>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onRefresh}
              title="重新載入"
              className="grid h-[34px] w-[34px] place-items-center rounded-lg border border-white/[0.1] text-fog transition hover:border-white/25 hover:text-snow active:scale-[0.97]"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
            {!digestReady && (
              <button
                onClick={startGeneration}
                disabled={starting || job?.state === "running" || !day}
                className="inline-flex items-center gap-1.5 rounded-lg bg-lime px-3.5 py-2 text-[13px] font-bold text-[#101503] shadow-[0_0_24px_rgba(185,243,76,0.25)] transition hover:shadow-[0_0_32px_rgba(185,243,76,0.4)] hover:brightness-110 active:scale-[0.97] disabled:opacity-60"
              >
                {job?.state === "running" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {job?.state === "running" ? "產生中…" : llmConfigured ? "產生摘要" : "準備摘要輸入"}
              </button>
            )}
            <button
              onClick={() => { onToggleRead(key); pushToast(isRead ? "已標記為未讀" : "已標記為已讀", "ok"); }}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-[13px] transition active:scale-[0.97] ${
                isRead ? "border-lime/30 bg-lime/[0.07] text-lime" : "border-white/[0.1] text-fog hover:border-white/25 hover:text-snow"
              }`}
            >
              <CheckCheck size={14} />
              {isRead ? "已讀" : "標記為已讀"}
            </button>
            <button
              onClick={doExport}
              disabled={!day}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] px-3.5 py-2 text-[13px] text-fog transition hover:border-white/25 hover:text-snow active:scale-[0.97] disabled:opacity-40"
            >
              <Download size={14} />
              匯出
            </button>
          </div>
        </div>
      </motion.header>

      {/* ---- date strip: 14 天時間線，有摘要的標 lime 點 ---- */}
      <DateStrip dayOffset={dayOffset} onOffset={onOffset} reportDays={reportDays} />

      {/* ---- tab bar ---- */}
      <div className="sticky top-11 z-40 -mx-5 mt-6 border-b border-white/[0.07] bg-ink/85 px-5 backdrop-blur-md md:-mx-8 md:px-8">
        <div className="flex items-center gap-0.5 overflow-x-auto">
          {TABS.map((t) => {
            const active = tab === t.id;
            const badge = badgeFor(t.id);
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`relative flex items-center gap-1.5 whitespace-nowrap px-3.5 py-3 text-[13px] transition-colors ${active ? "text-snow" : "text-dim hover:text-fog"}`}
              >
                <t.icon size={14} className={active ? "text-lime" : ""} />
                {t.label}
                {badge && (
                  <span className={`rounded px-1 font-mono text-[9.5px] tabular ${active ? "bg-lime/15 text-lime" : "bg-white/[0.06] text-dim"}`}>
                    {badge}
                  </span>
                )}
                {active && (
                  <motion.div
                    layoutId="tab-underline"
                    className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-lime shadow-[0_0_12px_rgba(185,243,76,0.6)]"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---- panels ---- */}
      <div className="relative mt-6 min-h-[60vh]">
        {error && (
          <div className="rounded-xl border border-danger/30 bg-danger/[0.06] px-4 py-3 text-[13px] text-danger">
            讀取失敗：{error}
          </div>
        )}
        {!day && !error && (
          <div className="space-y-3">
            <div className="panel h-32 animate-pulse" />
            <div className="panel h-64 animate-pulse" />
          </div>
        )}
        {day && (
          <AnimatePresence mode="wait">
            <motion.div
              key={tab + day.key}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              {tab === "digest" && (
                <DigestTab
                  day={day}
                  job={job}
                  llmConfigured={llmConfigured}
                  onGenerate={startGeneration}
                  onOpenReport={onOpenReport}
                  pushToast={pushToast}
                  items={reportItems}
                  reload={reloadReports}
                />
              )}
              {tab === "events" && <EventsTab day={day} jumpTo={jumpTo} />}
              {tab === "heat" && <HeatTab day={day} />}
              {tab === "people" && <PeopleTab day={day} />}
              {tab === "media" && <MediaTab day={day} onReload={onRefresh} pushToast={pushToast} canRefresh={mediaRefresh} jumpTo={jumpTo} />}
              {tab === "messages" && <MessagesTab day={day} jump={jump} />}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

/** 14 天時間線：每格一天，有摘要的標 lime 點，點下去直接跳到那天。 */
function DateStrip({ dayOffset, onOffset, reportDays }: {
  dayOffset: number;
  onOffset: (n: number) => void;
  reportDays: Set<string>;
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      {Array.from({ length: 14 }, (_, i) => {
        const offset = -13 + i;
        const info = dayInfoForOffset(offset);
        const active = offset === dayOffset;
        const has = reportDays.has(info.key);
        return (
          <button
            key={info.key}
            onClick={() => onOffset(offset)}
            className={`relative flex shrink-0 flex-col items-center gap-0.5 rounded-lg border px-2.5 py-1.5 transition active:scale-[0.95] ${
              active
                ? "border-lime/50 bg-lime/10"
                : "border-white/[0.06] hover:border-white/15"
            }`}
          >
            <span className={`font-mono text-[11px] tabular leading-none ${active ? "text-lime" : "text-fog"}`}>
              {info.labelShort}
            </span>
            <span className={`text-[9px] leading-none ${active ? "text-lime/70" : "text-dim"}`}>
              {info.weekday}
            </span>
            {has ? (
              <span className={`mt-0.5 h-1.5 w-1.5 rounded-full ${active ? "bg-lime" : "bg-lime/60"}`} title="有摘要" />
            ) : (
              <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-white/[0.08]" />
            )}
          </button>
        );
      })}
    </div>
  );
}
