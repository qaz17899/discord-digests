import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Hash, ChevronLeft, ChevronRight, TrendingUp, TrendingDown, Minus,
  CheckCheck, Sparkles, FileWarning, Radar, Activity, Zap, ArrowUpRight,
  Satellite, RefreshCw, Eye, EyeOff, BookOpenCheck, Loader2,
} from "lucide-react";
import type { ChannelCard } from "@/lib/data";
import { dayInfoForOffset, nowInGmt8, fmtInt, agoLabel } from "@/lib/format";
import type { Overview } from "@/lib/data";
import { Sparkline, CountUp, Chip } from "./ui";

export type WallFilter = "all" | "events" | "unread" | "nodigest";
export type WallSort = "volume" | "growth" | "events";

interface WallProps {
  dayOffset: number;
  onOffset: (n: number) => void;
  readSet: Set<string>;
  onOpenChannel: (id: string) => void;
  onOpenReader: () => void;
  overview: Overview;
  onRefresh: () => void;
  refreshing: boolean;
}

/** Unread means "there is something here worth opening", not "you have not seen it". */
function isUnread(card: ChannelCard, readSet: Set<string>): boolean {
  return !readSet.has(card.key) && (card.events.length > 0 || card.ratio > 0.35);
}

const FILTERS: { id: WallFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "events", label: "有事件" },
  { id: "unread", label: "未讀" },
  { id: "nodigest", label: "缺摘要" },
];
const SORTS: { id: WallSort; label: string }[] = [
  { id: "volume", label: "訊息量" },
  { id: "growth", label: "增幅" },
  { id: "events", label: "事件數" },
];

export function DateNav({ dayOffset, onOffset, compact = false, loading = false }: {
  dayOffset: number; onOffset: (n: number) => void; compact?: boolean; loading?: boolean;
}) {
  const info = dayInfoForOffset(dayOffset);
  const todayKey = dayInfoForOffset(0).key;
  const onDatePick = (value: string) => {
    if (!value) return;
    const [y, m, d] = value.split("-").map(Number);
    const target = Date.UTC(y, m - 1, d);
    const now = nowInGmt8();
    const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    onOffset(Math.round((target - base) / 86400000));
  };
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onOffset(Math.max(-13, dayOffset - 1))}
        disabled={dayOffset <= -13 || loading}
        className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 text-fog transition hover:border-lime/40 hover:text-lime disabled:opacity-25 disabled:hover:border-white/10 disabled:hover:text-fog"
        aria-label="前一天"
      >
        <ChevronLeft size={15} />
      </button>
      <div className={`flex items-baseline gap-2 px-2 ${compact ? "" : "min-w-[210px] justify-center"}`}>
        <span className={`font-display font-600 text-snow tabular ${compact ? "text-[14px]" : "text-[17px]"}`} style={{ fontWeight: 600 }}>
          {info.labelFull}
        </span>
        <span className="text-[12px] text-dim">{info.weekday}</span>
        <span className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] tracking-wider ${info.isToday ? "border-lime/40 text-lime" : "border-white/10 text-fog"}`}>
          {info.rel}
        </span>
        <span className="inline-flex h-4 w-4 items-center justify-center">
          <Loader2
            size={12}
            className={`animate-spin text-lime transition-opacity duration-150 ${
              loading ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
          />
        </span>
      </div>
      <button
        onClick={() => onOffset(Math.min(0, dayOffset + 1))}
        disabled={dayOffset >= 0 || loading}
        className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 text-fog transition hover:border-lime/40 hover:text-lime disabled:opacity-25 disabled:hover:border-white/10 disabled:hover:text-fog"
        aria-label="後一天"
      >
        <ChevronRight size={15} />
      </button>
      <input
        type="date"
        value={info.key}
        max={todayKey}
        disabled={loading}
        onChange={(e) => onDatePick(e.target.value)}
        aria-label="跳到日期"
        className={`h-8 rounded-lg border border-white/10 bg-transparent px-2 font-mono text-[11px] text-dim outline-none transition [color-scheme:dark] hover:border-lime/40 hover:text-lime focus:border-lime/50 disabled:opacity-50 ${compact ? "w-[100px]" : "w-[120px]"}`}
      />
    </div>
  );
}

export function StatusWall({ dayOffset, onOffset, readSet, onOpenChannel, onOpenReader, overview, onRefresh, refreshing }: WallProps) {
  const info = dayInfoForOffset(dayOffset);
  const [filter, setFilter] = useState<WallFilter>("all");
  const [sort, setSort] = useState<WallSort>("volume");
  const [hideRead, setHideRead] = useState(false);

  const isLoading = overview.loading || refreshing;
  const days = overview.cards;

  const totals = useMemo(() => {
    const msgs = days.reduce((a, d) => a + d.count, 0);
    const events = days.reduce((a, d) => a + d.events.length, 0);
    const critical = days.reduce((a, d) => a + d.events.filter((e) => e.importance >= 4).length, 0);
    const digestReady = days.filter((d) => d.hasDigest).length;
    const hottest = days.slice().sort((a, b) => b.count - a.count)[0];
    const unread = days.filter((d) => isUnread(d, readSet)).length;
    return { msgs, events, critical, digestReady, hottest, unread };
  }, [days, readSet]);

  const shown = useMemo(() => {
    let list = days;
    if (filter === "events") list = list.filter((d) => d.events.length > 0);
    if (filter === "unread") list = list.filter((d) => isUnread(d, readSet));
    if (filter === "nodigest") list = list.filter((d) => !d.hasDigest);
    if (hideRead) list = list.filter((d) => !readSet.has(d.key));
    const sorted = [...list];
    if (sort === "volume") sorted.sort((a, b) => b.count - a.count);
    if (sort === "growth") sorted.sort((a, b) => b.ratio - a.ratio);
    if (sort === "events") sorted.sort((a, b) => b.events.length - a.events.length || b.maxImportance - a.maxImportance);
    return sorted;
  }, [days, filter, sort, readSet, hideRead]);

  return (
    <div className="relative mx-auto max-w-[1440px] px-5 md:px-8 pb-24">
      {/* header */}
      <header className="pt-8 md:pt-10">
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
          <div className="mb-2 flex items-center gap-2">
            <div className="micro-label">STATUS WALL / 頻道狀態總覽</div>
            <span
              className={`inline-flex items-center gap-1 rounded-full border border-lime/30 bg-lime/10 px-2 py-0.5 font-mono text-[10.5px] text-lime transition-opacity duration-150 ${
                isLoading ? "opacity-100" : "opacity-0 pointer-events-none"
              }`}
            >
              <Loader2 size={10} className="animate-spin" />
              載入中…
            </span>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h1 className="font-display text-[34px] md:text-[44px] font-700 leading-[1.05] tracking-tight" style={{ fontWeight: 700 }}>
              {info.rel}
              <br />
              頻道動態<span className="text-lime text-glow-lime">彙整</span>
              <span className="caret-blink text-lime">_</span>
            </h1>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={onOpenReader}
                className="inline-flex items-center gap-2 rounded-xl border border-lime/35 bg-lime/[0.06] px-3.5 py-2 text-[13px] font-bold text-lime transition hover:bg-lime/[0.12]"
              >
                <BookOpenCheck size={14} />
                讀摘要
              </button>
              <DateNav dayOffset={dayOffset} onOffset={onOffset} loading={isLoading} />
            </div>
          </div>
        </motion.div>

        {/* stats strip */}
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08, duration: 0.5 }}
          className={`mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.05] md:grid-cols-5 transition-opacity duration-200 ${
            isLoading ? "opacity-50 pointer-events-none" : "opacity-100"
          }`}
        >
          {[
            { icon: Activity, label: `監控訊息總量 · ${info.key}`, value: <CountUp value={totals.msgs} duration={400} />, sub: `${days.length} 個頻道這一天` },
            { icon: Zap, label: "偵測事件", value: <CountUp value={totals.events} duration={400} />, sub: `${totals.critical} 起高重要性`, hot: totals.critical > 0 },
            { icon: Sparkles, label: "摘要就緒", value: <><CountUp value={totals.digestReady} duration={400} /><span className="text-dim text-[15px]">/{days.length}</span></>, sub: "點頻道可產生摘要" },
            {
              icon: Satellite, label: "最活躍頻道",
              value: (
                <span className="block truncate text-[19px]" title={totals.hottest?.name}>
                  {totals.hottest ? totals.hottest.name : "—"}
                </span>
              ),
              sub: totals.hottest ? `${fmtInt(totals.hottest.count)} 則` : "此日無資料",
            },
            { icon: CheckCheck, label: "待處理", value: <CountUp value={totals.unread} duration={400} />, sub: "有動靜且未讀", hot: totals.unread > 0 },
          ].map((s, i) => (
            <div key={i} className="min-w-0 bg-panel px-4 py-3.5">
              <div className="flex items-center gap-1.5 text-dim">
                <s.icon size={12} />
                <span className="micro-label">{s.label}</span>
              </div>
              <div className={`mt-1.5 font-display text-[24px] font-700 leading-none tabular ${s.hot ? "text-lime" : "text-snow"}`} style={{ fontWeight: 700 }}>
                {s.value}
              </div>
              <div className="mt-1 text-[11px] text-dim">{s.sub}</div>
            </div>
          ))}
        </motion.div>

        {/* filter / sort row */}
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.16 }}
          className="mt-5 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`rounded-lg border px-3 py-1.5 text-[12.5px] transition-all ${
                  filter === f.id
                    ? "border-lime/50 bg-lime/10 text-lime"
                    : "border-white/[0.08] text-fog hover:border-white/20 hover:text-snow"
                }`}
              >
                {f.label}
                {f.id === "unread" && totals.unread > 0 && (
                  <span className="ml-1.5 rounded bg-lime/20 px-1 font-mono text-[10px] text-lime">{totals.unread}</span>
                )}
              </button>
            ))}
            <button
              onClick={() => setHideRead((v) => !v)}
              title="隱藏已讀"
              className={`grid h-8 w-8 place-items-center rounded-lg border transition-all ${
                hideRead ? "border-lime/50 bg-lime/10 text-lime" : "border-white/[0.08] text-dim hover:border-white/20 hover:text-snow"
              }`}
            >
              {hideRead ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-fog transition hover:border-lime/40 hover:text-lime disabled:opacity-50"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
              重新載入
            </button>
            <span className="micro-label">SORT</span>
            <div className="flex overflow-hidden rounded-lg border border-white/[0.08]">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSort(s.id)}
                  className={`px-3 py-1.5 text-[12.5px] transition-colors ${sort === s.id ? "bg-white/10 text-snow" : "text-dim hover:text-fog"}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </motion.div>
      </header>

      {overview.error && (
        <div className="mt-5 rounded-xl border border-danger/30 bg-danger/[0.06] px-4 py-3 text-[13px] text-danger">
          讀取失敗：{overview.error}
        </div>
      )}

      {/* the wall */}
      <div
        className={`mt-5 min-h-[380px] grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 transition-opacity duration-150 ${
          isLoading ? "opacity-60 pointer-events-none" : "opacity-100"
        }`}
        key={filter + sort + String(hideRead)}
      >
        {isLoading && !days.length
          ? Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
          : shown.map((day, i) => (
              <ChannelCardTile
                key={day.id}
                day={day}
                index={i}
                read={readSet.has(day.key)}
                digestReady={day.hasDigest}
                unread={isUnread(day, readSet)}
                onOpen={() => onOpenChannel(day.id)}
              />
            ))}
        {!isLoading && shown.length === 0 && (
          <div className="col-span-full grid place-items-center rounded-xl border border-dashed border-white/10 py-20 text-center">
            <Radar size={22} className="text-dim" />
            <div className="mt-3 text-[14px] text-fog">
              {days.length === 0 ? "這天沒有收到任何訊息" : "此篩選條件下沒有頻道"}
            </div>
            <div className="mt-1 text-[12px] text-dim">{days.length === 0 ? "請切換日期，或確認收集器是否正常運作" : "可切換回「全部」檢視"}</div>
          </div>
        )}
      </div>

      <footer className="mt-14 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-4">
        <span className="font-mono text-[10.5px] tracking-wider text-dim">
          DISCORD DIGESTS — 資料擷取自 Discord{overview.generatedAt ? ` · 統計更新於 ${overview.generatedAt.slice(11, 19)}` : ""}
        </span>
        <span className="font-mono text-[10.5px] tracking-wider text-dim">←→ 鍵切換日期</span>
      </footer>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="panel h-[218px] animate-pulse p-4">
      <div className="h-4 w-24 rounded bg-white/[0.06]" />
      <div className="mt-4 h-7 w-32 rounded bg-white/[0.06]" />
      <div className="mt-4 h-11 rounded bg-white/[0.04]" />
      <div className="mt-3 h-3 w-40 rounded bg-white/[0.05]" />
    </div>
  );
}

// ---------------------------------------------------------------- card

function ChannelCardTile({ day, index, read, digestReady, unread, onOpen }: {
  day: ChannelCard; index: number; read: boolean; digestReady: boolean; unread: boolean; onOpen: () => void;
}) {
  const up = day.ratio > 0.005;
  const down = day.ratio < -0.005;
  const surging = day.ratio > 0.6;
  const hasCritical = day.maxImportance >= 4;

  return (
    <motion.button
      initial={{ opacity: 0, y: 18, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: 0.05 + Math.min(index, 12) * 0.045, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      onClick={onOpen}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.985 }}
      className={`panel glow-hover group relative overflow-hidden p-4 text-left ${read ? "opacity-55 saturate-[0.6]" : ""}`}
    >
      {/* top accent for critical */}
      {hasCritical && !read && (
        <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-danger/70 to-transparent" />
      )}

      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Hash size={14} className="shrink-0 text-dim" />
          <span className="truncate text-[15px] font-bold text-snow">{day.name}</span>
          {unread && <span className="pulse-dot ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-lime shadow-[0_0_8px_rgba(185,243,76,0.8)]" />}
        </div>
        {read ? (
          <Chip tone="dim"><CheckCheck size={11} />已讀</Chip>
        ) : digestReady ? (
          <Chip tone="lime"><Sparkles size={11} />摘要就緒</Chip>
        ) : (
          <Chip tone="amber"><FileWarning size={11} />待產生</Chip>
        )}
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="font-display text-[30px] font-700 leading-none tracking-tight text-snow tabular" style={{ fontWeight: 700 }}>
          <CountUp value={day.count} duration={400} />
        </span>
        <span
          className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] tabular ${
            up ? "bg-lime/10 text-lime" : down ? "bg-white/[0.05] text-fog" : "bg-white/[0.05] text-dim"
          }`}
        >
          {up ? <TrendingUp size={11} /> : down ? <TrendingDown size={11} /> : <Minus size={11} />}
          {up ? "+" : ""}{(day.ratio * 100).toFixed(1)}%
        </span>
        {surging && <Chip tone="danger">流量暴增</Chip>}
      </div>
      <div className="mt-0.5 text-[11px] text-dim">
        則訊息 · 前日 {fmtInt(day.prevCount)}
        {day.allTimeTotal ? <span className="text-dim/70"> · 累計 {fmtInt(day.allTimeTotal)}</span> : null}
      </div>

      <div className="mt-3 h-11 opacity-80 transition-opacity duration-300 group-hover:opacity-100">
        <Sparkline data={day.hourly} hot={hasCritical} id={day.key} />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {day.events.length > 0 ? (
            <>
              <Zap size={11} className={hasCritical ? "text-danger" : "text-amber"} />
              <span className={`text-[11.5px] ${hasCritical ? "text-danger" : "text-amber/90"}`}>{day.events.length} 事件</span>
              {day.topKeywords.slice(0, 1).map((k) => (
                <span key={k} className="hidden truncate rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-fog sm:inline">{k}</span>
              ))}
            </>
          ) : (
            <span className="text-[11.5px] text-dim">無事件 · 日常流量</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-[10px] text-dim">
            {day.lastTs ? agoLabel(day.lastTs, Date.now()) : "無訊息"}
          </span>
          <ArrowUpRight size={13} className="text-dim transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-lime" />
        </div>
      </div>
    </motion.button>
  );
}
