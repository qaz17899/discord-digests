import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { TowerControl, Settings2 } from "lucide-react";
import { StatusWall } from "./components/StatusWall";
import { ReaderView } from "./components/ReaderView";
import { Console, SECTIONS, type SectionId } from "./components/console/Console";
import { Workspace, type TabId } from "./components/Workspace";
import { Toaster, type Toast } from "./components/ui";
import { api, type ApiSettings, type ApiChannelStatus } from "./lib/api";
import { pad2, nowInGmt8, msOfDay } from "./lib/format";
import { useLiveStatus, useOverview } from "./lib/data";

type View =
  | { t: "wall" }
  | { t: "read" }
  | { t: "console"; section: SectionId }
  | { t: "channel"; id: string; tab: TabId };

const TAB_IDS: TabId[] = ["digest", "events", "heat", "people", "media", "messages"];
const SECTION_IDS = SECTIONS.map((s) => s.id);

/** #/ or #/read or #/console/<section> or #/c/<channelId>/<tab> — a view you can bookmark. */
function parseHash(): View {
  if (/^#\/read\b/.test(location.hash)) return { t: "read" };
  const m = /^#\/c\/(\d+)(?:\/([a-z]+))?/.exec(location.hash);
  if (m) {
    const tab = TAB_IDS.includes(m[2] as TabId) ? (m[2] as TabId) : "digest";
    return { t: "channel", id: m[1], tab };
  }
  const c = /^#\/(?:console|settings)(?:\/([a-z]+))?/.exec(location.hash);
  if (c) {
    const section = SECTION_IDS.includes(c[1] as SectionId) ? (c[1] as SectionId) : "channels";
    return { t: "console", section };
  }
  return { t: "wall" };
}

function hashOf(v: View): string {
  if (v.t === "console") return `#/console/${v.section}`;
  if (v.t === "read") return "#/read";
  return v.t === "wall" ? "#/" : `#/c/${v.id}/${v.tab}`;
}

function loadSet(key: string): Set<string> {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(key) ?? "[]"));
  } catch {
    return new Set();
  }
}
function saveSet(key: string, s: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...s].slice(-400)));
  } catch { /* private mode: read state just does not persist */ }
}

let toastId = 0;

export default function App() {
  const [view, setView] = useState<View>(parseHash);
  const [dayOffset, setDayOffset] = useState(0); // 預設看「今天」
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [readSet, setReadSet] = useState<Set<string>>(() => loadSet("wt-read-v1"));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [settings, setSettings] = useState<ApiSettings | null>(null);

  const queryClient = useQueryClient();
  const overview = useOverview(dayOffset, refreshNonce);

  // The console edits config.json; the shell keeps the latest copy so every
  // section reads the same state.
  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.settings());
    } catch {
      // The console shows its own error state; the wall does not need settings.
    }
  }, []);
  useEffect(() => { loadSettings(); }, [loadSettings, refreshNonce]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view.t, view.t === "channel" ? view.id : ""]);

  // Collector freshness: the newest timestamp any channel has written.
  // 移到 SystemTray 裡輪詢，App 不再每 10 秒重渲染。

  const pushToast = useCallback((msg: string, kind: "ok" | "info" | "danger" = "ok") => {
    const id = ++toastId;
    setToasts((prev) => [...prev.slice(-3), { id, msg, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 2800);
  }, []);

  const reload = useCallback(() => {
    setRefreshNonce((n) => n + 1);
    void queryClient.invalidateQueries();
  }, [queryClient]);

  // The address bar follows the view, and the view follows the address bar.
  useEffect(() => {
    if (location.hash !== hashOf(view)) history.pushState(null, "", hashOf(view));
  }, [view]);
  useEffect(() => {
    const sync = () => setView(parseHash());
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const openChannel = useCallback((id: string) => setView({ t: "channel", id, tab: "digest" }), []);
  const openConsole = useCallback(() => setView({ t: "console", section: "channels" }), []);
  const setSection = useCallback((section: SectionId) => setView({ t: "console", section }), []);
  const setTab = useCallback((tab: TabId) => setView((v) => (v.t === "channel" ? { ...v, tab } : v)), []);
  const changeDay = useCallback((n: number) => {
    setDayOffset(n);
    setView((v) => (v.t === "channel" ? { ...v, tab: "digest" } : v));
  }, []);

  const toggleRead = useCallback((key: string) => {
    setReadSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      saveSet("wt-read-v1", next);
      return next;
    });
  }, []);

  const goBack = useCallback(() => setView({ t: "wall" }), []);
  /** 從摘要或歸檔跳到某頻道某一天的工作區 */
  const openReport = useCallback((id: string, offset: number) => {
    setDayOffset(offset);
    setView({ t: "channel", id, tab: "digest" });
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (document.querySelector("[data-lightbox]")) return; // 燈箱接管快捷鍵
      if (e.key === "ArrowLeft") changeDay(Math.max(-13, dayOffset - 1));
      if (e.key === "ArrowRight") changeDay(Math.min(0, dayOffset + 1));
      if (e.key === "Escape") setView((v) => (v.t === "wall" ? v : { t: "wall" }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dayOffset, changeDay]);


  // Collector freshness: the newest timestamp any channel has written.
  // 移到 SystemTray 裡輪詢，App 不再每 10 秒重渲染。

  return (
    <div className="relative min-h-screen bg-ink text-snow">
      {/* ambience */}
      <div className="grid-layer pointer-events-none fixed inset-0 z-0" />
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute -top-40 left-1/2 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-lime/[0.05] blur-[130px]" />
        <div className="absolute -bottom-52 -left-40 h-[460px] w-[560px] rounded-full bg-blurple/[0.07] blur-[130px]" />
        <div className="absolute right-[-180px] top-1/3 h-[380px] w-[420px] rounded-full bg-cyan/[0.04] blur-[120px]" />
      </div>
      <div className="noise-layer" />

      {/* system bar */}
      <div className="sticky top-0 z-50 border-b border-white/[0.06] bg-ink/80 backdrop-blur-md">
        <div className="mx-auto flex h-11 max-w-[1440px] items-center justify-between px-5 md:px-8">
          <button onClick={goBack} className="group flex items-center gap-2.5">
            <div className="grid h-6 w-6 place-items-center rounded-md border border-lime/30 bg-lime/10">
              <TowerControl size={13} className="text-lime" />
            </div>
            <span className="font-display text-[13px] font-700 tracking-[0.14em]" style={{ fontWeight: 700 }}>
              DISCORD DIGESTS
            </span>
            <span className="hidden text-[12px] text-dim sm:inline">訊息監控與摘要</span>
          </button>
          <SystemTray
            overviewChannels={overview.channels}
            isConsole={view.t === "console"}
            onOpenConsole={openConsole}
          />
        </div>
      </div>

      {/* views */}
      <div className="relative z-10">
        <AnimatePresence mode="wait">
          {view.t === "console" && settings && (
            <motion.div
              key="console"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14, transition: { duration: 0.18 } }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <Console
                settings={settings}
                channels={overview.cards}
                section={view.section}
                onSection={setSection}
                onBack={goBack}
                onChanged={reload}
                onOpenChannel={openChannel}
                pushToast={pushToast}
              />
            </motion.div>
          )}
          {view.t === "console" && !settings && (
            <div className="mx-auto max-w-[1200px] px-5 pt-28 text-[13px] text-dim md:px-8">讀取設定…</div>
          )}
          {view.t === "wall" && (
            <motion.div
              key="wall"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14, transition: { duration: 0.18 } }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <StatusWall
                dayOffset={dayOffset}
                onOffset={changeDay}
                readSet={readSet}
                onOpenChannel={openChannel}
                onOpenReader={() => setView({ t: "read" })}
                overview={overview}
                onRefresh={reload}
                refreshing={overview.loading}
              />
            </motion.div>
          )}
          {view.t === "channel" && (
            <motion.div
              key={`ws-${view.id}`}
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14, transition: { duration: 0.18 } }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <Workspace
                channelId={view.id}
                tab={view.tab}
                onTab={setTab}
                dayOffset={dayOffset}
                onOffset={changeDay}
                onBack={goBack}
                onSwitchChannel={openChannel}
                channels={overview.channels.map((c) => ({ id: c.id, name: c.name, total: c.total }))}
                readSet={readSet}
                onToggleRead={toggleRead}
                onRefresh={reload}
                refreshNonce={refreshNonce}
                llmConfigured={overview.llmConfigured}
                mediaRefresh={overview.mediaRefresh}
                pushToast={pushToast}
                onOpenReport={openReport}
              />
            </motion.div>
          )}
          {view.t === "read" && (
            <motion.div
              key="read"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14, transition: { duration: 0.18 } }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            >
              <ReaderView onBack={goBack} onOpenChannel={openReport} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Toaster toasts={toasts} />
    </div>
  );
}

/** 頂部狀態列：時鐘 + 收集器心跳狀態 + 頻道數。獨立輪詢與計時，避免觸發全域重新渲染。 */
function SystemTray({
  overviewChannels,
  isConsole,
  onOpenConsole,
}: {
  overviewChannels: ApiChannelStatus[];
  isConsole: boolean;
  onOpenConsole: () => void;
}) {
  const [clock, setClock] = useState(() => nowInGmt8());
  const { channels: liveChannels } = useLiveStatus(10000);
  useEffect(() => {
    const t = setInterval(() => setClock(nowInGmt8()), 1000);
    return () => clearInterval(t);
  }, []);
  const channels = liveChannels.length ? liveChannels : overviewChannels;
  const collector = useMemo(() => {
    const newest = channels.reduce((max, c) => (c.lastTs > max ? c.lastTs : max), "");
    if (!newest) return { live: false, label: "尚無資料" };
    const ms = msOfDay(newest);
    if (ms === null) return { live: false, label: newest };
    const ageMin = (Date.now() - ms) / 60000;
    return {
      live: ageMin < 5,
      label: ageMin < 5 ? "收集器運作中" : `最後寫入 ${newest.slice(11, 16)}`,
    };
  }, [channels]);
  return (
    <div className="flex items-center gap-4 font-mono text-[10px] tracking-wider text-dim">
      <span className="hidden items-center gap-1.5 md:flex" title="以各頻道最後寫入時間判斷">
        <span className={`h-1.5 w-1.5 rounded-full ${collector.live ? "bg-lime pulse-dot" : "bg-danger"}`} />
        {collector.label}
      </span>
      <span className="hidden tabular lg:inline">{channels.length} 頻道 · 累計 {channels.reduce((a, c) => a + c.total, 0).toLocaleString("en-US")} 則</span>
      <span className="tabular text-fog" title="GMT+8">
        {pad2(clock.getUTCHours())}:{pad2(clock.getUTCMinutes())}
        <span className="text-dim">:{pad2(clock.getUTCSeconds())}</span>
      </span>
      <button
        onClick={onOpenConsole}
        title="控制台"
        className={`grid h-6 w-6 place-items-center rounded-md border transition ${
          isConsole
            ? "border-lime/40 bg-lime/10 text-lime"
            : "border-white/[0.08] text-dim hover:border-white/25 hover:text-snow"
        }`}
      >
        <Settings2 size={12} />
      </button>
    </div>
  );
}
