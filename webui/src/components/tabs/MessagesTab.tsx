import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search, X, ArrowUpToLine, ArrowDownToLine, Flame, CornerUpLeft,
  ImageOff, FileText, SearchX, Link2, PencilLine, Trash2, ArrowDownWideNarrow,
} from "lucide-react";
import { searchIndex, type ChannelDay, type Message } from "@/lib/data";
import { tsHHMM, fmtInt } from "@/lib/format";
import { Avatar } from "../ui";
import type { JumpSignal } from "../Workspace";

// --------------------------------------------------------- estimate

function strUnits(s: string): number {
  let u = 0;
  for (let i = 0; i < s.length; i++) u += s.charCodeAt(i) > 0x2e7f ? 2 : 1;
  return u;
}

function estimateHeight(m: Message, widthPx: number): number {
  const contentW = Math.max(220, widthPx - 200);
  const unitsPerLine = contentW / 7.1;
  let lines = 0;
  for (const seg of m.content.split("\n")) lines += Math.max(1, Math.ceil(strUnits(seg) / unitsPerLine));
  let h = 8 + 18 + lines * 21 + 10;
  if (m.replyTo) h += 17;
  if (m.embeds.length) h += 22 * m.embeds.length;
  if (m.reactions.length) h += 27;
  if (m.attachments.length) h += m.attachments[0].kind === "image" ? 140 : 44;
  return h;
}

const OVERSCAN = 14;

interface Virtualizer {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  total: number;
  range: [number, number];
  offsetsRef: React.RefObject<Float64Array>;
  scrollToPos: (pos: number) => void;
  setRowEl: (pos: number, el: HTMLElement | null) => void;
  rebuild: (clearMeasured: boolean) => void;
  handleScroll: () => void;
}

function useVirtualizer(itemCount: number, estimate: (pos: number) => number, depsKey: string): Virtualizer {
  const scrollRef = useRef<HTMLDivElement>(null);
  const measuredRef = useRef(new Map<number, number>());
  const estRef = useRef(estimate);
  estRef.current = estimate;
  const offsetsRef = useRef<Float64Array>(new Float64Array(1)) as React.RefObject<Float64Array>;
  const [total, setTotal] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 50]);
  const rowEls = useRef(new Map<number, HTMLElement>());
  const rafRef = useRef(0);

  const compute = useCallback((): Float64Array => {
    const arr = new Float64Array(itemCount + 1);
    for (let i = 0; i < itemCount; i++) arr[i + 1] = arr[i] + (measuredRef.current.get(i) ?? estRef.current(i));
    return arr;
  }, [itemCount]);

  const bsearch = useCallback((arr: Float64Array, val: number): number => {
    let lo = 0, hi = itemCount;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= val) lo = mid; else hi = mid - 1;
    }
    return lo;
  }, [itemCount]);

  const updateRange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const arr = offsetsRef.current;
    const st = el.scrollTop;
    const vh = el.clientHeight;
    const start = Math.max(0, bsearch(arr, st) - OVERSCAN);
    const end = Math.min(itemCount, bsearch(arr, st + vh) + OVERSCAN);
    setRange((prev) => (prev[0] === start && prev[1] === end ? prev : [start, end]));
  }, [bsearch, itemCount]);

  const rebuild = useCallback((clearMeasured: boolean) => {
    if (clearMeasured) measuredRef.current.clear();
    const arr = compute();
    offsetsRef.current = arr;
    setTotal(arr[itemCount]);
    updateRange();
  }, [compute, itemCount, updateRange]);

  // list identity changed → full reset
  useEffect(() => {
    rebuild(true);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey]);

  // measure rendered rows after every commit; correct offsets when reality diverges
  useEffect(() => {
    let changed = false;
    rowEls.current.forEach((el, pos) => {
      const h = el.getBoundingClientRect().height;
      const cur = measuredRef.current.get(pos) ?? estRef.current(pos);
      if (Math.abs(h - cur) > 3) {
        measuredRef.current.set(pos, h);
        changed = true;
      }
    });
    if (changed) {
      const arr = compute();
      offsetsRef.current = arr;
      setTotal(arr[itemCount]);
    }
  });

  const handleScroll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(updateRange);
  }, [updateRange]);

  const scrollToPos = useCallback((pos: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const arr = offsetsRef.current;
    el.scrollTop = Math.max(0, (arr[Math.min(pos, itemCount)] ?? 0) - 110);
    updateRange();
  }, [itemCount, updateRange]);

  const setRowEl = useCallback((pos: number, el: HTMLElement | null) => {
    if (el) rowEls.current.set(pos, el);
    else rowEls.current.delete(pos);
  }, []);

  return { scrollRef, total, range, offsetsRef, scrollToPos, setRowEl, rebuild, handleScroll };
}

// --------------------------------------------------------- row

function MessageRow({ m, flash }: { m: Message; flash: boolean }) {
  return (
    <div className={`flex gap-3 border-b border-white/[0.04] px-4 py-2 transition-colors hover:bg-white/[0.025] ${flash ? "flash-row" : ""}`}>
      <div className="w-[38px] shrink-0 pt-[3px] text-right font-mono text-[10.5px] tabular text-dim">
        {tsHHMM(m.ts)}
      </div>
      <Avatar author={m.author} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-bold" style={{ color: `hsl(${m.author.hue} 70% 72%)` }}>
            {m.author.name}
          </span>
          {m.author.tag && <span className="font-mono text-[10px] text-dim">{m.author.tag}</span>}
          {m.author.bot && (
            <span className="rounded bg-blurple/20 px-1 font-mono text-[8.5px] font-bold tracking-wider text-blurple">BOT</span>
          )}
          {m.deleted && (
            <span className="inline-flex items-center gap-0.5 rounded bg-danger/15 px-1 font-mono text-[9px] text-danger">
              <Trash2 size={8} />已刪除
            </span>
          )}
          {m.edited && !m.deleted && (
            <span className="inline-flex items-center gap-0.5 font-mono text-[9px] text-dim">
              <PencilLine size={8} />已編輯
            </span>
          )}
          <span className="font-mono text-[9px] text-white/20" title={m.id}>…{m.id.slice(-6)}</span>
        </div>
        {m.replyTo && (
          <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-dim">
            <CornerUpLeft size={11} className="shrink-0 text-dim/70" />
            <span className="font-medium text-fog/80">@{m.replyTo.name}</span>
            <span className="truncate opacity-70">{m.replyTo.excerpt || "（跨日訊息）"}</span>
          </div>
        )}
        {m.content && (
          <div className={`whitespace-pre-wrap break-words text-[13.5px] leading-[1.55] ${m.deleted ? "text-dim line-through" : "text-snow/85"}`}>
            {m.content}
          </div>
        )}
        {m.embeds.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {m.embeds.map((e, i) => (
              <a
                key={i}
                href={e.url}
                target="_blank"
                rel="noreferrer"
                className="flex max-w-[560px] items-start gap-2 rounded-lg border-l-2 border-lime/40 bg-white/[0.02] px-2.5 py-1.5 transition hover:bg-lime/[0.05]"
              >
                <Link2 size={12} className="mt-0.5 shrink-0 text-lime/70" />
                <span className="min-w-0">
                  {e.title && <span className="block truncate text-[12.5px] font-bold text-snow/85">{e.title}</span>}
                  {(e.desc || e.url) && <span className="block truncate text-[11.5px] text-dim">{e.desc || e.url}</span>}
                </span>
              </a>
            ))}
          </div>
        )}
        {m.attachments.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {m.attachments.map((a, i) =>
              a.kind === "image" ? (
                a.expired || !a.url ? (
                  <div key={i} className="flex h-[120px] w-[190px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/15 bg-white/[0.02] text-dim">
                    <ImageOff size={16} />
                    <span className="font-mono text-[9.5px] tracking-wider">連結已失效</span>
                    <span className="max-w-[170px] truncate px-2 text-[10px] opacity-60">{a.filename}</span>
                  </div>
                ) : (
                  <a key={i} href={a.url} target="_blank" rel="noreferrer">
                    <img
                      src={a.url}
                      alt={a.filename}
                      loading="lazy"
                      onError={(e) => { e.currentTarget.style.display = "none"; }}
                      className="h-[120px] rounded-lg border border-white/10 object-cover"
                      style={{ width: a.w && a.h ? Math.round((120 * a.w) / a.h) : 190 }}
                    />
                  </a>
                )
              ) : (
                <a key={i} href={a.url ?? undefined} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 transition hover:border-lime/30">
                  <FileText size={14} className="text-blurple" />
                  <span className="text-[12px] text-fog">{a.filename}</span>
                  {a.expired && <span className="font-mono text-[9px] text-danger/80">NO LINK</span>}
                </a>
              ),
            )}
          </div>
        )}
        {m.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {m.reactions.map((r, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.03] px-1.5 py-px text-[11px]">
                <span>{r.e}</span>
                <span className="font-mono text-[10px] tabular text-fog">{r.n}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------- tab

export function MessagesTab({ day, jump }: { day: ChannelDay; jump: JumpSignal | null }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [flashIdx, setFlashIdx] = useState<number | null>(null);
  /** 預設新的在上（與媒體圖片牆排序一致）；舊到新為即時對話閱讀順序。 */
  const [newestFirst, setNewestFirst] = useState(true);
  const widthRef = useRef(900);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), 240);
    return () => clearTimeout(t);
  }, [query]);

  const msgs = day.messages;
  const listIdxs = useMemo(() => {
    if (!debounced) return null;
    const idx = searchIndex(day);
    const out: number[] = [];
    // A day can hold 20k messages; this is a plain substring scan over a
    // prebuilt lowercase index, which is the fastest thing the browser does.
    for (let i = 0; i < idx.length; i++) if (idx[i].includes(debounced)) out.push(i);
    return out;
  }, [day, debounced]);

  const itemCount = listIdxs ? listIdxs.length : msgs.length;
  /** 顯示順序：新的在上時，第 0 列是最後一則。 */
  const at = useCallback((pos: number) => (newestFirst ? itemCount - 1 - pos : pos), [itemCount, newestFirst]);
  const msgAt = useCallback(
    (pos: number) => msgs[listIdxs ? listIdxs[at(pos)] : at(pos)],
    [msgs, listIdxs, at],
  );
  const estimate = useCallback((pos: number) => estimateHeight(msgAt(pos), widthRef.current), [msgAt]);

  const depsKey = `${day.key}|${debounced}|${newestFirst}`;
  const v = useVirtualizer(itemCount, estimate, depsKey);

  // track container width → rebuild estimates on big changes
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    widthRef.current = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (Math.abs(w - widthRef.current) > 40) {
        widthRef.current = w;
        v.rebuild(true);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // jump-to signal from the events tab
  useEffect(() => {
    if (!jump) return;
    if (debounced) { setQuery(""); setDebounced(""); }
    const t = setTimeout(() => {
      const pos = newestFirst ? itemCount - 1 - jump.idx : jump.idx;
      v.scrollToPos(pos);
      // 行高實測校正後再精修一次
      setTimeout(() => v.scrollToPos(pos), 420);
      setFlashIdx(jump.idx);
      setTimeout(() => setFlashIdx(null), 2400);
    }, 140);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce]);

  /** first message index of an hour, for the peak jump */
  const peakIdx = useMemo(() => {
    const i = msgs.findIndex((m) => Math.floor(m.minute / 60) === day.peakHour);
    return i < 0 ? 0 : i;
  }, [msgs, day.peakHour]);

  const positions: number[] = [];
  for (let p = v.range[0]; p < v.range[1]; p++) positions.push(p);
  const topOffset = v.offsetsRef.current[Math.min(v.range[0], itemCount)] ?? 0;

  return (
    <div>
      {/* toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`搜尋 ${fmtInt(msgs.length)} 則訊息（作者或內容）…`}
            className="w-full rounded-lg border border-white/[0.09] bg-panel2 py-2 pl-9 pr-8 text-[13px] text-snow placeholder:text-dim/70 outline-none transition focus:border-lime/50 focus:ring-2 focus:ring-lime/15"
          />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-dim hover:text-snow">
              <X size={13} />
            </button>
          )}
        </div>
        <div className="font-mono text-[11px] tabular text-dim">
          {debounced ? (
            <span>符合 <span className="text-lime">{fmtInt(itemCount)}</span> / {fmtInt(msgs.length)} 則</span>
          ) : (
            <span>共 {fmtInt(msgs.length)} 則</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            data-sort
            title="切換新／舊在上"
            onClick={() => setNewestFirst((v2) => !v2)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/[0.09] px-2.5 text-[12px] text-fog transition hover:border-lime/40 hover:text-lime"
          >
            <ArrowDownWideNarrow size={13} className={newestFirst ? "" : "rotate-180"} />
            {newestFirst ? "新的在上" : "舊的在上"}
          </button>
          <button title="跳到開頭" onClick={() => v.scrollToPos(0)} className="grid h-8 w-8 place-items-center rounded-lg border border-white/[0.09] text-dim transition hover:border-lime/40 hover:text-lime">
            <ArrowUpToLine size={13} />
          </button>
          <button
            title={`跳到峰值時段 ${day.stats.peakMinLabel}`}
            onClick={() => {
              const pos = newestFirst ? itemCount - 1 - peakIdx : peakIdx;
              v.scrollToPos(pos);
              setFlashIdx(peakIdx);
              setTimeout(() => setFlashIdx(null), 2400);
            }}
            className="grid h-8 w-8 place-items-center rounded-lg border border-white/[0.09] text-dim transition hover:border-amber/50 hover:text-amber"
          >
            <Flame size={13} />
          </button>
          <button title="跳到結尾" onClick={() => v.scrollToPos(itemCount - 1)} className="grid h-8 w-8 place-items-center rounded-lg border border-white/[0.09] text-dim transition hover:border-lime/40 hover:text-lime">
            <ArrowDownToLine size={13} />
          </button>
        </div>
      </div>

      {/* stream */}
      <div ref={frameRef} className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-2">
          <span className="micro-label">RAW STREAM / {day.info.key}</span>
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-dim">
            <span className="h-1.5 w-1.5 rounded-full bg-lime pulse-dot" />
            VIRTUALIZED · {fmtInt(itemCount)} ROWS
          </span>
        </div>

        {itemCount === 0 ? (
          <div className="grid place-items-center py-24 text-center">
            <SearchX size={22} className="text-dim" />
            <div className="mt-3 text-[13.5px] text-fog">
              {msgs.length === 0 ? `${day.info.key} 這天沒有訊息` : `找不到符合「${debounced}」的訊息`}
            </div>
            <div className="mt-1 text-[11.5px] text-dim">
              {msgs.length === 0 ? "請選擇其他日期" : "請嘗試更換關鍵字，或清除搜尋以檢視全部"}
            </div>
          </div>
        ) : (
          <div
            ref={v.scrollRef}
            onScroll={v.handleScroll}
            className="relative overflow-y-auto overscroll-contain"
            style={{ height: "min(68vh, 760px)" }}
          >
            <div style={{ height: v.total + 56, position: "relative" }}>
              <div style={{ position: "absolute", top: topOffset, left: 0, right: 0 }}>
                {positions.map((pos) => {
                  const m = msgAt(pos);
                  return (
                    <div key={m.id} ref={(el) => v.setRowEl(pos, el)}>
                      <MessageRow m={m} flash={flashIdx === m.idx} />
                    </div>
                  );
                })}
              </div>
              <div className="absolute bottom-0 left-0 right-0 grid place-items-center py-4">
                <span className="font-mono text-[10px] tracking-[0.2em] text-dim">— END OF STREAM · {fmtInt(itemCount)} MESSAGES —</span>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="mt-2 text-right font-mono text-[10px] text-dim">
        預估行高 + 實測校正 · 僅掛載可視範圍 ±{OVERSCAN} 列
      </div>
    </div>
  );
}
