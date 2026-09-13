import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ImageOff, Maximize2, X, ChevronLeft, ChevronRight, Image as ImageIcon,
  Images, RefreshCw, Loader2, Clock3, LayoutGrid, Flame, ImagePlay, Crosshair, ArrowDownWideNarrow,
} from "lucide-react";
import type { ChannelDay, MediaItem } from "@/lib/data";
import { api } from "@/lib/api";
import { tsHHMM, fmtInt, pad2 } from "@/lib/format";
import { Avatar, SectionLabel } from "../ui";
import { HourRange } from "../HourRange";

type MediaFilter = "all" | "gif" | "img" | "expired";
type MediaView = "time" | "masonry" | "heat";

/** Tiles rendered per scroll step. */
const PAGE = 48;

/** Above this many pictures per view, tiles skip their entry animation. */
const ANIMATE_LIMIT = 200;

const isGif = (m: MediaItem) => m.att.filename.toLowerCase().endsWith(".gif");

/**
 * 瀑布欄寬與間距。多欄布局讓每一欄按卡片實際高度獨立堆疊，
 * 不會因為 CSS Grid 的整列高度被最長圖片撐開而在其它欄留下空洞。
 */
const GAP = 12; // 磚塊間距，跟 gap-3 一致
/** grid-auto-rows 的單位列高。越小 span 越貼近圖片真實高度、留下來的空白越不起眼。
 * 必須配 grid-row:span N（N 由比例算）—— 這是 #15 定案的瀑布修法，
 * 取代 CSS 多欄 column-fill:balance（會在新頁載入／圖載完時重新平衡，把已讀過的磚塊搬回視窗）。 */
const ROW = 6;
/** 磚塊底部的檔名列高度（px-3 py-2 + 10px 行高 + 邊框 ≈ 30px），用來算 span。 */
const FOOTER_H = 30;

/** 快取量到的圖片比例，key 是檔名＋時間（同一張圖會出現很多次）。
 *
 * 這份是「開頁面時」從 localStorage 載進來的，只在那一刻讀：
 * 瀏覽過程中量到的比例會寫進 learned（存起來給下次用），但絕不影響這次已經畫出來的
 * 磚塊 —— 只要讀它，某張圖載完就會改變某個磚塊的高度，下面的東西就被推走。 */
const RATIO_KEY = "wt-media-ratios";
const readCache = (): Map<string, number> => {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(RATIO_KEY) ?? "{}")) as [string, number][]);
  } catch {
    return new Map();
  }
};
const ratioCache = readCache();
/** 這次瀏覽量到的比例，只寫不讀（下次開頁面才讀得到）。 */
const learned = new Map<string, number>();

/**
 * 這次瀏覽「主動量到」的比例：早期資料沒存寬高，那就把圖抓下來量。
 *
 * 不是多抓一份：抓的就是磚塊要顯示的那張圖，瀏覽器之後直接從快取拿。
 * 重點是它比使用者的捲動早一步，所以大部分磚塊一開始就能拿到真實比例、
 * 位置留得剛剛好（不會像只靠估計值那樣留出一大堆空白）。
 */
const probed = new Map<string, number>();
/** probe 失敗（連結死了）就不要再等它，直接照估計值畫出來讓它顯示「連結已失效」。 */
const probeFailed = new Set<string>();

/** 對尚未獲取比例的圖片發送探測請求（並行上限 8）。onLand 用於觸發畫面重新渲染。 */
function probeUpTo(list: MediaItem[], limit: number, onLand: () => void) {
  const need = list
    .slice(0, limit)
    .filter((m) => !(m.att.w && m.att.h) && !ratioCache.has(ratioKeyOf(m)) && !probed.has(ratioKeyOf(m)) && !probeFailed.has(ratioKeyOf(m)) && m.att.url);
  let next = 0;
  const pump = () => {
    const m = need[next++];
    if (!m) return;
    const img = new Image();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        const r = img.naturalWidth / img.naturalHeight;
        probed.set(ratioKeyOf(m), r);
        rememberRatio(ratioKeyOf(m), r);
      } else {
        probeFailed.add(ratioKeyOf(m));
      }
      onLand();
      pump();
    };
    img.onload = finish;
    img.onerror = finish;
    setTimeout(finish, 6000); // 卡住的就當失敗，不要讓磚塊永遠是骨架
    img.src = m.att.url!;
  };
  for (let i = 0; i < 8; i++) pump();
}

/** 還不知道比例的圖（早期資料沒存寬高）先按這個比例留位置。只在啟動時從快取算一次，
 *  瀏覽過程中絕對不再變 —— 一變就會讓所有未知比例的磚塊同時改高，整個版面就跳了。 */
const startupGuess = (() => {
  const known = [...ratioCache.values()].sort((a, b) => a - b);
  return known.length > 20 ? known[Math.floor(known.length / 2)] : 0.75;
})();

function rememberRatio(key: string, ratio: number) {
  learned.set(key, ratio);
  // 寫入不需要很即時，500ms 一次即可。
  clearTimeout(saveRatios.timer);
  saveRatios.timer = setTimeout(saveRatios, 500) as unknown as ReturnType<typeof setTimeout>;
}

function saveRatios() {
  try {
    const merged = new Map([...ratioCache, ...learned]);
    localStorage.setItem(RATIO_KEY, JSON.stringify(Object.fromEntries([...merged].slice(-4000))));
  } catch {
    // 快取寫不進去不影響任何事
  }
}
saveRatios.timer = 0 as unknown as ReturnType<typeof setTimeout>;

/** 這張圖的高／寬比。已知就用真的，未知用這個清單自己的中間值，再不行用啟動值。 */
function ratioOf(m: MediaItem, guess: number): { ratio: number; known: boolean } {
  if (m.att.w && m.att.h) return { ratio: m.att.w / m.att.h, known: true };
  const exact = probed.get(ratioKeyOf(m)) ?? ratioCache.get(ratioKeyOf(m));
  if (exact) return { ratio: exact, known: true };
  return { ratio: guess, known: false };
}

/** 這一批圖的「常見比例」：有存寬高的那些取中間值，用來給沒存的留位置。 */
function medianRatio(list: MediaItem[]): number {
  const known = list
    .map((m) => m.att.w && m.att.h ? m.att.w / m.att.h : probed.get(ratioKeyOf(m)) ?? ratioCache.get(ratioKeyOf(m)) ?? 0)
    .filter((r) => r > 0)
    .sort((a, b) => a - b);
  return known.length > 20 ? known[Math.floor(known.length / 2)] : startupGuess;
}

/**
 * 快取的 key：用網址的路徑（不含後面那串簽名）。
 *
 * 原本用「檔名＋時間」，但 Discord 上同一分鐘常常有一堆叫 image.png 的圖，
 * 不同圖會共用同一個 key → 拿到別張圖的比例 → 磚塊高度和預留的格子不一致，
 * 就會互相壓到。網址路徑帶 message id，是唯一的，而且換簽名時不會變。
 */
const ratioKeyOf = (m: MediaItem) => (m.att.url ? m.att.url.split("?")[0] : `${m.att.filename}|${m.ts}`);

export function MediaTab({ day, onReload, pushToast, canRefresh, jumpTo }: {
  day: ChannelDay;
  onReload: () => void;
  pushToast: (msg: string, kind?: "ok" | "info" | "danger") => void;
  canRefresh: boolean;
  jumpTo: (idx: number) => void;
}) {
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [view, setView] = useState<MediaView>("masonry");
  /** 只要這段時間的圖；預設整日。 */
  const [hours, setHours] = useState<[number, number]>([0, 24]);
  /** 新的在上面（預設）或舊的在上面。 */
  const [newestFirst, setNewestFirst] = useState(true);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  // A day can hold thousands of images. Only this many tiles are in the DOM at
  // once; scrolling brings in the next page. Without it the browser lays out
  // ~3,000 images and every view switch freezes.
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement | null>(null);
  /** 瀑布的欄寬：用來給尚未量到比例的骨架預留高度。 */
  const gridWrap = useRef<HTMLDivElement | null>(null);
  const [gridW, setGridW] = useState(0);

  const cols = gridW >= 1100 ? 4 : gridW >= 720 ? 3 : 2;
  const colW = gridW > 0 ? (gridW - GAP * (cols - 1)) / cols : 0;

  const isDead = useCallback(
    (m: MediaItem) => m.att.expired || broken.has(m.att.url ?? m.att.filename),
    [broken],
  );

  /** A picture whose URL died during this session. */
  const onBreak = useCallback((m: MediaItem) => {
    setBroken((prev) => new Set(prev).add(m.att.url ?? m.att.filename));
  }, []);

  /** Reaction total of the message a picture came from — the heat signal. */
  const heatOf = useMemo(() => {
    const map = new Map<number, number>();
    for (const m of day.messages) map.set(m.idx, m.reactions.reduce((a, r) => a + r.n, 0));
    return map;
  }, [day.messages]);

  const counts = useMemo(() => {
    let gif = 0, img = 0, dead = 0;
    for (const m of day.media) {
      const g = isGif(m);
      const d = isDead(m);
      if (g && !d) gif++;
      if (!g && !d) img++;
      if (d) dead++;
    }
    return { gif, img, dead };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day.media, broken]);

  const items = useMemo(() => {
    let list = day.media;
    if (filter === "gif") list = list.filter((m) => isGif(m) && !isDead(m));
    else if (filter === "img") list = list.filter((m) => !isGif(m) && !isDead(m));
    else if (filter === "expired") list = list.filter(isDead);
    if (hours[0] > 0 || hours[1] < 24) {
      list = list.filter((m) => {
        const h = Number(m.ts.slice(11, 13));
        return h >= hours[0] && h < hours[1];
      });
    }
    if (view === "heat") {
      return [...list].sort((a, b) => (heatOf.get(b.idx) ?? 0) - (heatOf.get(a.idx) ?? 0) || a.idx - b.idx);
    }
    // day.media 本來就是新的在前，只有「舊的在上」要反過來。
    return newestFirst ? list : [...list].reverse();
  }, [day.media, filter, view, isDead, heatOf, hours, newestFirst]);

  /** What actually reaches the DOM. */
  const visible = useMemo(() => (shown >= items.length ? items : items.slice(0, shown)), [items, shown]);

  /**
   * 早期資料沒存寬高時主動把圖抓下來量，純粹為了下次開頁面時留位置留得準
   * （量到的比例寫進 localStorage，下次 mount 就直接拿到真值）。
   * 這次的版面不靠它：比例在磚塊 mount 時就凍死了，probe 落地不會再回頭改高度。
   */
  const probeList = useMemo(() => items.slice(0, shown + PAGE * 2), [items, shown]);
  useEffect(() => { probeUpTo(probeList, probeList.length, () => {}); }, [probeList]);

  /** 這一天沒存寬高的圖用哪個比例凍結（只在磚塊 mount 時用一次，之後不再變）。 */
  const guess = useMemo(() => medianRatio(probeList), [probeList]);

  /** Hour bands for the timeline view. `ts` is GMT+8 "YYYY-MM-DD HH:MM:SS". */
  const bands = useMemo(() => {
    if (view !== "time") return null;
    const map = new Map<number, MediaItem[]>();
    for (const m of visible) {
      const hour = Number(m.ts.slice(11, 13));
      const h = Number.isNaN(hour) ? 0 : hour;
      if (!map.has(h)) map.set(h, []);
      map.get(h)!.push(m);
    }
    // 時間軸預設也讓新的在上面：新的小時在前。
    return [...map.entries()].sort((a, b) => (newestFirst ? b[0] - a[0] : a[0] - b[0]));
  }, [visible, view, newestFirst]);

  useLayoutEffect(() => {
    const el = gridWrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setGridW(e.contentRect.width));
    ro.observe(el);
    setGridW(el.clientWidth);
    return () => ro.disconnect();
  }, [view]);

  useEffect(() => setShown(PAGE), [filter, view, day.key, hours, newestFirst]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || shown >= items.length) return;
    const io = new IntersectionObserver(
      (entries) => entries[0].isIntersecting && setShown((n) => n + PAGE),
      { rootMargin: "800px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, items.length]);

  // keyboard nav in lightbox
  useEffect(() => {
    if (lightbox === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      if (e.key === "ArrowRight") setLightbox((v) => (v === null ? v : Math.min(items.length - 1, v + 1)));
      if (e.key === "ArrowLeft") setLightbox((v) => (v === null ? v : Math.max(0, v - 1)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, items.length]);

  /**
   * 向 Discord 請求新的 CDN 簽名。僅請求已失效的連結，避免重複請求正常圖片。
   */
  const doRefresh = async () => {
    const urls = [
      ...new Set(
        day.media
          .filter((m) => isDead(m))
          .map((m) => m.att.url)
          .filter((u): u is string => !!u),
      ),
    ];
    if (!urls.length) {
      pushToast("沒有失效的連結需要更新", "info");
      return;
    }
    setRefreshing(true);
    setProgress([0, urls.length]);
    try {
      let refreshed = 0;
      let failed = 0;
      for (let i = 0; i < urls.length; i += 500) {
        const r = await api.refreshMedia(day.def.id, urls.slice(i, i + 500));
        refreshed += Object.keys(r.urls ?? {}).length;
        failed += (r.failed ?? []).length;
        setProgress([Math.min(i + 500, urls.length), urls.length]);
      }
      const tail = failed ? `，${fmtInt(failed)} 個已遭刪除或無法更新` : "";
      pushToast(
        refreshed ? `已更新 ${fmtInt(refreshed)} 個連結${tail}` : failed ? `無可更新的連結${tail}` : "連結均為最新狀態",
        refreshed ? "ok" : "info",
      );
      setBroken(new Set());
      onReload();
    } catch (err) {
      pushToast(`更新連結失敗：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setRefreshing(false);
      setProgress(null);
    }
  };

  const current = lightbox !== null ? items[lightbox] : null;
  /** 瀑布容器：每欄獨立堆疊，卡片不再被其它欄的高度對齊。 */
  const masonry = (list: MediaItem[], offset: number) => (
    <div
      className="grid"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: ROW,
        columnGap: GAP,
        rowGap: 0,
      }}
    >
      {list.map((m, i) => (
        <MasonryCell key={`${m.att.url}-${m.idx}-${i}`} m={m} guess={guess} colW={colW} dead={isDead(m)}>
          {tile(m, offset + i, { natural: true, guess })}
        </MasonryCell>
      ))}
    </div>
  );

  const tile = (m: MediaItem, i: number, opts: { rank?: number; featured?: boolean; natural?: boolean; guess?: number } = {}) => (
    <Tile
      key={`${m.idx}-${m.att.filename}-${i}`}
      m={m}
      index={i}
      guess={opts.guess ?? guess}
      dead={isDead(m)}
      gif={isGif(m)}
      heat={heatOf.get(m.idx) ?? 0}
      rank={opts.rank ?? -1}
      featured={opts.featured ?? false}
      natural={opts.natural ?? false}
      animate={items.length <= ANIMATE_LIMIT}
      onOpen={() => setLightbox(items.indexOf(m))}
      onDead={() => onBreak(m)}
    />
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SectionLabel>MEDIA / 媒體圖片牆</SectionLabel>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10.5px] tabular text-dim">
            {fmtInt(day.media.length)} 張
            {" · "}
            <span className="text-cyan/90">{fmtInt(counts.gif)} GIF</span>
            {" · "}
            <span className={counts.dead ? "text-danger/80" : ""}>{fmtInt(counts.dead)} 失效</span>
          </span>
          <div className="flex overflow-hidden rounded-lg border border-white/[0.08]">
            {([["time", "時間軸", Clock3], ["masonry", "瀑布", LayoutGrid], ["heat", "熱度", Flame]] as const).map(([id, label, Icon]) => (
              <button
                key={id}
                data-view={id}
                onClick={() => setView(id)}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] transition-colors ${
                  view === id ? "bg-white/10 text-snow" : "text-dim hover:text-fog"
                }`}
              >
                <Icon size={11} className={view === id ? "text-lime" : ""} />
                {label}
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded-lg border border-white/[0.08]">
            {([["all", "全部"], ["gif", "GIF"], ["img", "圖片"], ["expired", "失效"]] as [MediaFilter, string][]).map(([id, label]) => (
              <button
                key={id}
                data-filter={id}
                onClick={() => setFilter(id)}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] transition-colors ${
                  filter === id ? (id === "gif" ? "bg-cyan/15 text-cyan" : "bg-white/10 text-snow") : "text-dim hover:text-fog"
                }`}
              >
                {id === "gif" && <ImagePlay size={11} />}
                {label}
              </button>
            ))}
          </div>
          {view !== "heat" && (
            <button
              onClick={() => setNewestFirst((v) => !v)}
              data-sort
              title="切換新／舊在上"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 py-1.5 text-[12px] text-fog transition hover:border-lime/40 hover:text-lime"
            >
              <ArrowDownWideNarrow size={12} className={newestFirst ? "" : "rotate-180"} />
              {newestFirst ? "新的在上" : "舊的在上"}
            </button>
          )}
          {canRefresh ? (
            <button
              onClick={doRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 py-1.5 text-[12px] text-fog transition hover:border-lime/40 hover:text-lime disabled:opacity-50"
            >
              {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {progress ? `更新中 ${fmtInt(progress[0])}/${fmtInt(progress[1])}` : "更新連結"}
            </button>
          ) : counts.dead > 0 ? (
            <span className="font-mono text-[10.5px] text-amber/80">設定 bot token 才能更新連結</span>
          ) : null}
        </div>
      </div>

      {day.media.length > 0 && (
        <div className="mb-4">
          <HourRange
            hourly={day.hourly}
            value={hours}
            onChange={setHours}
            eventHours={[...new Set(day.events.map((e) => Math.floor(e.startMin / 60)))]}
          />
        </div>
      )}

      {items.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-white/12 py-24 text-center">
          <Images size={22} className="text-dim" />
          <div className="mt-3 text-[14px] text-fog">
            {day.media.length === 0
              ? `#${day.def.name} · ${day.info.labelShort} 這天沒有圖片或 GIF`
              : hours[0] > 0 || hours[1] < 24
                ? `${String(hours[0]).padStart(2, "0")}:00–${String(hours[1]).padStart(2, "0")}:00 這段時間沒有符合的圖片`
                : "此篩選下沒有圖片"}
          </div>
        </div>
      ) : view === "time" && bands ? (
        <div ref={gridWrap} className="space-y-7">
          {bands.map(([h, list]) => (
            <section key={h}>
              <div className="mb-3 flex items-baseline gap-2.5">
                <span className="font-mono text-[13px] font-bold tabular text-snow">{pad2(h)}:00</span>
                <span className="h-px flex-1 bg-white/[0.07]" />
                <span className="font-mono text-[10px] tabular text-dim">{list.length} 張</span>
                <span className="font-mono text-[10px] tabular text-dim">訊息 {fmtInt(day.hourly[h] ?? 0)}</span>
              </div>
              {masonry(list, 0)}
            </section>
          ))}
        </div>
      ) : view === "heat" ? (
        <div className="grid grid-flow-dense grid-cols-2 gap-3 md:grid-cols-4" style={{ gridAutoRows: "150px" }}>
          {visible.map((m, i) => tile(m, i, { rank: i, featured: (heatOf.get(m.idx) ?? 0) > 0 && i < 6 }))}
        </div>
      ) : (
        <div ref={gridWrap}>{masonry(visible, 0)}</div>
      )}

      {shown < items.length && (
        <div ref={sentinel} className="grid place-items-center py-8 text-[12px] text-dim">
          <span className="font-mono tabular">已顯示 {fmtInt(shown)} / {fmtInt(items.length)}</span>
        </div>
      )}

      {/* lightbox */}
      <AnimatePresence>
        {current && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-6 backdrop-blur-md"
            onClick={() => setLightbox(null)}
            data-lightbox="1"
          >
            <button className="absolute right-5 top-5 grid h-10 w-10 place-items-center rounded-full border border-white/15 text-fog transition hover:border-lime/50 hover:text-lime" onClick={() => setLightbox(null)}>
              <X size={17} />
            </button>
            {lightbox! > 0 && (
              <button
                className="absolute left-4 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-white/15 text-fog transition hover:border-lime/50 hover:text-lime"
                onClick={(e) => { e.stopPropagation(); setLightbox((v) => Math.max(0, (v ?? 1) - 1)); }}
              >
                <ChevronLeft size={17} />
              </button>
            )}
            {lightbox! < items.length - 1 && (
              <button
                className="absolute right-4 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-white/15 text-fog transition hover:border-lime/50 hover:text-lime"
                onClick={(e) => { e.stopPropagation(); setLightbox((v) => Math.min(items.length - 1, (v ?? 0) + 1)); }}
              >
                <ChevronRight size={17} />
              </button>
            )}
            <motion.div
              key={current.att.url ?? current.att.filename}
              initial={{ opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ type: "spring", stiffness: 320, damping: 28 }}
              className="flex max-h-full w-full max-w-[880px] flex-col items-center"
              onClick={(e) => e.stopPropagation()}
            >
              {isDead(current) || !current.att.url ? (
                <div className="flex h-[320px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/20 bg-panel2 text-dim">
                  <ImageOff size={26} />
                  <span className="font-mono text-[11px] tracking-[0.2em]">連結已失效</span>
                  <span className="text-[12px] opacity-60">{current.att.filename}</span>
                </div>
              ) : (
                <div className="relative flex items-center justify-center overflow-hidden rounded-xl border border-white/15 bg-panel">
                  <img
                    src={current.att.url}
                    alt={current.att.filename}
                    onError={() => setBroken((prev) => new Set(prev).add(current.att.url ?? current.att.filename))}
                    className="max-h-[64vh] max-w-full object-contain"
                  />
                </div>
              )}

              {/* the message it came from */}
              <div className="mt-3 w-full rounded-xl border border-white/10 bg-panel2/95 p-3.5 backdrop-blur">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Avatar author={current.author} size={24} />
                  <span className="text-[13px] font-bold" style={{ color: `hsl(${current.author.hue} 70% 72%)` }}>{current.author.name}</span>
                  <span className="font-mono text-[10.5px] tabular text-dim">{tsHHMM(current.ts)}</span>
                  {isGif(current) && (
                    <span className="inline-flex items-center gap-1 rounded bg-cyan/15 px-1.5 py-0.5 font-mono text-[9px] tracking-wider text-cyan">
                      <ImagePlay size={10} />
                      GIF
                    </span>
                  )}
                  <span className="flex-1" />
                  <button
                    onClick={() => { setLightbox(null); jumpTo(current.idx); }}
                    className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-fog transition hover:border-lime/50 hover:text-lime"
                  >
                    <Crosshair size={11} />
                    定位原文
                  </button>
                </div>
                {day.messages[current.idx]?.content && (
                  <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-snow/85">
                    {day.messages[current.idx].content}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {(day.messages[current.idx]?.reactions ?? []).map((r, i) => (
                    <span key={i} className="inline-flex items-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.03] px-1.5 py-px text-[11px]">
                      {r.e}
                      <span className="font-mono text-[10px] tabular text-fog">{r.n}</span>
                    </span>
                  ))}
                  <span className="flex-1" />
                  <span className="font-mono text-[9.5px] text-dim">
                    {current.att.filename} · {(lightbox ?? 0) + 1}/{items.length} · ← → 切換
                  </span>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * 瀑布磚塊：一個 grid item，grid-row 的 span 在 mount 時就凍結。
 *
 * 凍結是關鍵 —— CSS Grid 的 auto-flow 不會像 CSS 多欄那樣回頭重新平衡，
 * 已畫出來的磚塊永遠不動，新磚塊只往後排；比例未知時用 guess 凍結
 * （圖靠 object-cover 裁切，下次開頁面才會拿到真實比例）。這正是「往下滑
 * 一直看到重複圖片」的根治：沒有任何東西會把已讀過的磚塊搬回視窗裡。
 */
function MasonryCell({ m, guess, colW, dead, children }: {
  m: MediaItem;
  guess: number;
  colW: number;
  dead: boolean;
  children: ReactNode;
}) {
  const [{ ratio }] = useState(() => ratioOf(m, guess));
  const span = colW > 0
    ? Math.max(1, Math.ceil(((dead ? 150 : colW / ratio) + FOOTER_H + GAP) / ROW))
    : 1;
  return <div style={{ gridRow: `span ${span}` }}>{children}</div>;
}

function Tile({ m, index, dead, gif, heat, rank, featured, natural, guess, animate, onOpen, onDead }: {
  m: MediaItem;
  index: number;
  dead: boolean;
  gif: boolean;
  heat: number;
  rank: number;
  featured: boolean;
  natural: boolean;
  /** 沒存寬高時拿來留位置的比例，由呼叫端傳進來（不能是會變動的全域值）。 */
  guess: number;
  animate: boolean;
  onOpen: () => void;
  onDead: () => void;
}) {
  /**
   * 比例在磚塊掛載時就定下來，之後永遠不變。
   *
   * 如果每次 render 都重新問快取，圖一載完（記得比例）就會立刻改用新比例，
   * 磚塊高度跟著改，下面的東西就被推走 —— 那正是「滑起來一直抖」的原因。
   * 快取只在下次開頁面時發揮作用：那時候留位置從一開始就是準的。
   */
  const [{ ratio, known }] = useState(() => ratioOf(m, guess));
  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (known) return;
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      rememberRatio(ratioKeyOf(m), img.naturalWidth / img.naturalHeight);
    }
  };
  /** hover 才出現的作者列；貼在圖片底邊（包裝層＝圖片，不會偏）。 */
  const caption = (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex translate-y-2 items-center justify-between px-3 pb-2.5 opacity-0 transition duration-300 group-hover:translate-y-0 group-hover:opacity-100">
      <div className="flex min-w-0 items-center gap-2">
        <Avatar author={m.author} size={20} />
        <span className="truncate text-[11.5px] font-bold text-white/90">{m.author.name}</span>
        <span className="font-mono text-[10px] tabular text-white/60">{tsHHMM(m.ts)}</span>
      </div>
      <Maximize2 size={13} className="shrink-0 text-lime" />
    </div>
  );
  return (
    <motion.button
      initial={animate ? { opacity: 0, y: 16 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 12) * 0.03, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      onClick={onOpen}
      title={`${tsHHMM(m.ts)} · ${m.att.filename}`}
      className={`media-tile group relative block w-full overflow-hidden rounded-xl border border-white/[0.07] bg-panel2 text-left transition hover:border-lime/35 ${
        featured ? "md:col-span-2 md:row-span-2" : ""
      }`}
    >
      {dead ? (
        <div className={`flex w-full flex-col items-center justify-center gap-2 bg-white/[0.015] text-dim ${natural ? "h-[150px]" : "h-full min-h-[120px]"}`}>
          <ImageOff size={18} />
          <span className="font-mono text-[9.5px] tracking-[0.18em]">連結已失效</span>
          <span className="max-w-[80%] truncate px-3 text-[10.5px] opacity-60">{m.att.filename}</span>
        </div>
      ) : natural ? (
        // 瀑布／時間軸：比例在畫出來之前就量好了（沒量到不會畫，先給骨架），
        // 所以這裡的框就是圖真正的比例，既不留黑邊也不會擠到下一排。
        <div className="relative">
          <div className="w-full overflow-hidden" style={{ aspectRatio: String(ratio) }}>
            <img
              src={m.att.url!}
              alt={m.att.filename}
              loading="lazy"
              decoding="async"
              onLoad={onImgLoad}
              onError={onDead}
              className="block h-full w-full object-cover transition duration-500 group-hover:scale-[1.02]"
            />
          </div>
          {caption}
        </div>
      ) : (
        <div className="relative h-full">
          <img
            src={m.att.url!}
            alt={m.att.filename}
            loading="lazy"
            decoding="async"
            onError={onDead}
            className="block h-full w-full object-cover transition duration-500 group-hover:scale-[1.02]"
            style={{ aspectRatio: featured ? String(ratio) : undefined }}
          />
          {caption}
        </div>
      )}

      {/* 遮罩蓋滿整張卡（含下面的檔名列）—— 只蓋圖片的話，
          灰底的底邊會停在圖片底部，看起來像遮罩「偏上面」。 */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent opacity-0 transition duration-300 group-hover:opacity-100" />

      {gif && !dead && (
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-cyan/20 px-1.5 py-0.5 font-mono text-[8.5px] tracking-wider text-cyan backdrop-blur">
          <ImagePlay size={9} />
          GIF
        </span>
      )}
      {rank >= 0 && rank < 6 && (
        <span className="absolute right-2 top-2 rounded bg-black/65 px-1.5 py-0.5 font-mono text-[9px] font-bold text-lime backdrop-blur">
          #{rank + 1}
        </span>
      )}
      {dead && (
        <div className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[8.5px] tracking-wider text-danger backdrop-blur">
          EXPIRED
        </div>
      )}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="min-w-0 truncate font-mono text-[10px] text-dim transition group-hover:text-fog">{m.att.filename}</span>
        {heat > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] tabular text-fog">
            <Flame size={10} className="text-amber" />
            {heat}
          </span>
        ) : (
          <ImageIcon size={11} className="shrink-0 text-dim/60" />
        )}
      </div>
    </motion.button>
  );
}
