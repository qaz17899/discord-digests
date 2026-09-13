import { useCallback, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Hash, Cable, ScrollText, CalendarClock, Wand2, ShieldCheck, DownloadCloud } from "lucide-react";
import type { ChannelCard } from "@/lib/data";
import { api, type ApiSettings } from "@/lib/api";
import { ChannelsSection } from "./ChannelsSection";
import { ProviderSection } from "./ProviderSection";
import { PromptsSection } from "./PromptsSection";
import { ScheduleSection } from "./ScheduleSection";
import { ManualSection } from "./ManualSection";
import { BackfillSection } from "./BackfillSection";

export type SectionId = "channels" | "provider" | "prompts" | "schedule" | "manual" | "backfill";

export const SECTIONS: { id: SectionId; label: string; desc: string; icon: typeof Hash }[] = [
  { id: "channels", label: "頻道管理", desc: "監控中、加入、停用", icon: Hash },
  { id: "provider", label: "AI 連線", desc: "Base URL · Key · 模型", icon: Cable },
  { id: "prompts", label: "提示詞", desc: "摘要引擎的 Prompt", icon: ScrollText },
  { id: "schedule", label: "自動排程", desc: "定時產生摘要", icon: CalendarClock },
  { id: "manual", label: "手動摘要", desc: "手動產生指定時段摘要", icon: Wand2 },
  { id: "backfill", label: "歷史回補", desc: "回補指定區間歷史訊息", icon: DownloadCloud },
];

interface Props {
  settings: ApiSettings;
  channels: ChannelCard[];
  section: SectionId;
  onSection: (s: SectionId) => void;
  onBack: () => void;
  onChanged: () => void;
  onOpenChannel: (id: string) => void;
  pushToast: (msg: string, kind?: "ok" | "info" | "danger") => void;
}

export function Console({ settings, channels, section, onSection, onBack, onChanged, onOpenChannel, pushToast }: Props) {
  // Sections reload the settings they depend on after a write, so the shell
  // owns one copy and hands the fresh one down.
  const [local, setLocal] = useState<ApiSettings | null>(null);
  const current = local ?? settings;

  const reload = useCallback(async () => {
    const next = await api.settings();
    setLocal(next);
    onChanged();
    return next;
  }, [onChanged]);

  return (
    <div className="mx-auto max-w-[1200px] px-5 pb-24 md:px-8">
      <motion.header
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="pt-6"
      >
        <button
          onClick={onBack}
          className="group inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] px-3 py-1.5 text-[12.5px] text-fog transition hover:border-lime/40 hover:text-lime"
        >
          <ArrowLeft size={14} className="transition-transform group-hover:-translate-x-0.5" />
          狀態牆
          <span className="ml-1 hidden rounded border border-white/10 px-1 font-mono text-[9.5px] text-dim sm:inline">ESC</span>
        </button>
        <div className="mt-5 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl border border-lime/25 bg-lime/[0.08]">
            <ShieldCheck size={19} className="text-lime" />
          </div>
          <div>
            <h1 className="text-[26px] font-bold leading-none tracking-tight text-snow">控制台</h1>
            <div className="mt-1.5 font-mono text-[10px] tracking-[0.14em] text-dim">
              CONTROL ROOM · 設定儲存於 config.json，無 Discord 寫入權限
            </div>
          </div>
        </div>
      </motion.header>

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[210px_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:sticky lg:top-[60px] lg:block lg:h-fit lg:space-y-1 lg:overflow-visible">
          {SECTIONS.map((s) => {
            const active = s.id === section;
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                onClick={() => onSection(s.id)}
                className={`group flex w-full shrink-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                  active
                    ? "border-lime/30 bg-lime/[0.07]"
                    : "border-transparent hover:border-white/[0.08] hover:bg-white/[0.03]"
                }`}
              >
                <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border transition ${
                  active ? "border-lime/40 bg-lime/10 text-lime" : "border-white/[0.08] text-dim group-hover:text-fog"
                }`}>
                  <Icon size={13} />
                </span>
                <span className="min-w-0">
                  <span className={`block truncate text-[13px] font-medium ${active ? "text-lime" : "text-fog"}`}>{s.label}</span>
                  <span className="block truncate text-[10.5px] text-dim">{s.desc}</span>
                </span>
              </button>
            );
          })}
        </nav>

        {/* 六個區塊一直留在 DOM 裡，只把沒在看的那幾個藏起來：切走再切回來時，
            沒儲存的編輯（提示詞、排程、摘要範圍、回補範圍）不會被抺掉。 */}
        <div className="min-w-0">
          <div className={section === "channels" ? "section-in" : "hidden"}>
            <ChannelsSection settings={current} channels={channels} onReload={reload} onChanged={onChanged} onOpenChannel={onOpenChannel} pushToast={pushToast} />
          </div>
          <div className={section === "provider" ? "section-in" : "hidden"}>
            <ProviderSection settings={current} onReload={reload} pushToast={pushToast} />
          </div>
          <div className={section === "prompts" ? "section-in" : "hidden"}>
            <PromptsSection settings={current} channels={channels} onReload={reload} pushToast={pushToast} />
          </div>
          <div className={section === "schedule" ? "section-in" : "hidden"}>
            <ScheduleSection settings={current} channels={channels} pushToast={pushToast} />
          </div>
          <div className={section === "manual" ? "section-in" : "hidden"}>
            <ManualSection channels={channels} settings={current} onOpenChannel={onOpenChannel} pushToast={pushToast} />
          </div>
          <div className={section === "backfill" ? "section-in" : "hidden"}>
            <BackfillSection channels={channels} onOpenChannel={onOpenChannel} pushToast={pushToast} />
          </div>
        </div>
      </div>
    </div>
  );
}
