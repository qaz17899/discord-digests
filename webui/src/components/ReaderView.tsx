// 摘要閱讀器：依序瀏覽 reports/ 目錄下的摘要。
// 已讀狀態保存於瀏覽器 localStorage。

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft, BookOpenCheck, CalendarDays, Check, ChevronRight, Clock3,
  FileText, Loader2, Sparkles, Download,
} from "lucide-react";
import { fmtInt } from "@/lib/format";
import { useReportBody, useReports, type ReportItem } from "@/lib/data";
import { isRead, markAllRead, markUnread, onReadChange } from "@/lib/reportRead";
import { Chip, SectionLabel } from "./ui";
import { Markdown } from "./Markdown";

export function ReaderView({ onBack, onOpenChannel }: {
  onBack: () => void;
  onOpenChannel: (channelId: string, dayOffset: number) => void;
}) {
  const { items, loading, error, reload } = useReports();
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(true);
  const [, bump] = useState(0);

  useEffect(() => onReadChange(() => bump((n) => n + 1)), []);

  const unread = items.filter((r) => !isRead(r.name));
  const queue = useMemo(() => (onlyUnread ? unread : items), [onlyUnread, unread, items]);

  // Land on the newest unread report; fall back to the newest one there is.
  useEffect(() => {
    if (selected && queue.some((r) => r.name === selected)) return;
    const first = queue[0] ?? items[0];
    if (first) setSelected(first.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, items, selected]);

  const current = items.find((r) => r.name === selected) ?? null;
  const { markdown, loading: bodyLoading, error: bodyError } = useReportBody(current?.name ?? null);

  // Reading a report marks it read, which is what makes the queue shrink.
  useEffect(() => {
    if (current && !bodyLoading && !bodyError && markdown) {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      bump((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.name, markdown, bodyLoading]);

  const step = (dir: number) => {
    if (!queue.length) return;
    const at = queue.findIndex((r) => r.name === selected);
    const next = Math.min(queue.length - 1, Math.max(0, (at < 0 ? 0 : at) + dir));
    setSelected(queue[next].name);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); step(1); }
      if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); step(-1); }
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="mx-auto max-w-[1240px] px-6 pb-16 pt-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.09] px-2.5 py-1.5 text-[12px] text-fog transition hover:border-lime/40 hover:text-lime"
          >
            <ArrowLeft size={13} />
            狀態牆
            <span className="font-mono text-[9.5px] text-dim">ESC</span>
          </button>
          <div>
            <div className="flex items-center gap-2">
              <BookOpenCheck size={15} className="text-lime" />
              <span className="text-[17px] font-bold text-snow">摘要閱讀</span>
              {unread.length > 0 && (
                <span className="rounded-md bg-lime/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-lime tabular">
                  {unread.length} 未讀
                </span>
              )}
            </div>
            <div className="mt-0.5 font-mono text-[10px] tracking-[0.18em] text-dim">
              READER / 共 {fmtInt(items.length)} 份 · J K 或 ↑ ↓ 切換
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOnlyUnread((v) => !v)}
            className={`rounded-lg border px-3 py-1.5 text-[12px] transition ${
              onlyUnread ? "border-lime/40 bg-lime/[0.08] text-lime" : "border-white/[0.09] text-fog hover:text-lime"
            }`}
          >
            只看未讀
          </button>
          <button
            onClick={() => { markAllRead(items.map((r) => r.name)); bump((n) => n + 1); }}
            disabled={!unread.length}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.09] px-3 py-1.5 text-[12px] text-fog transition hover:border-lime/40 hover:text-lime disabled:opacity-40"
          >
            <Check size={12} />
            全部已讀
          </button>
          <button
            onClick={reload}
            className="rounded-lg border border-white/[0.09] px-3 py-1.5 text-[12px] text-fog transition hover:border-lime/40 hover:text-lime"
          >
            重新載入
          </button>
        </div>
      </div>

      {error && <div className="panel mb-4 px-4 py-3 text-[13px] text-danger">讀取摘要清單失敗：{error}</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        {/* 佇列 */}
        <aside className="panel flex max-h-[78vh] flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-3.5 py-2.5">
            <span className="micro-label !text-[9.5px]">QUEUE / {queue.length} 份</span>
            <span className="font-mono text-[9.5px] tabular text-dim">{unread.length} 未讀</span>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            {!loading && queue.length === 0 && (
              <div className="px-3 py-10 text-center">
                <Check size={20} className="mx-auto text-lime" />
                <p className="mt-2 text-[13px] text-fog">全部讀完了</p>
                <button onClick={() => setOnlyUnread(false)} className="mt-2 font-mono text-[11px] text-dim underline hover:text-lime">
                  看全部 {items.length} 份
                </button>
              </div>
            )}
            {queue.map((r) => {
              const active = r.name === selected;
              const read = isRead(r.name);
              return (
                <button
                  key={r.name}
                  onClick={() => setSelected(r.name)}
                  className={`group relative flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                    active ? "bg-lime/[0.08]" : "hover:bg-white/[0.035]"
                  }`}
                >
                  {active && <span className="absolute left-0 top-1/2 h-7 w-[2px] -translate-y-1/2 rounded-full bg-lime" />}
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${read ? "bg-white/15" : "bg-lime pulse-dot"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`truncate text-[12.5px] font-bold ${active ? "text-lime" : "text-snow/85"}`}>
                        {r.channelName}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <span className="font-mono text-[10.5px] tabular text-dim">{r.label}</span>
                      <span className="font-mono text-[9.5px] text-dim/70">{r.weekday}</span>
                      <span className="font-mono text-[9.5px] text-dim/70">{r.range || (r.whole ? "全部歷史" : "全天")}</span>
                    </div>
                  </div>
                  <ChevronRight size={13} className={`mt-1 shrink-0 ${active ? "text-lime" : "text-dim/40"}`} />
                </button>
              );
            })}
          </div>
        </aside>

        {/* 閱讀器 */}
        <div className="min-w-0">
          {!current ? (
            <div className="panel grid place-items-center px-6 py-20 text-center">
              <FileText size={22} className="text-dim" />
              <div className="mt-3 text-[14px] text-fog">{loading ? "讀取中…" : "還沒有任何摘要"}</div>
              <p className="mt-1 text-[12.5px] text-dim">到頻道的摘要分頁按「產生摘要」，摘要就會出現在這裡。</p>
            </div>
          ) : (
            <>
              <div className="panel relative overflow-hidden p-5 md:p-6">
                <div className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-lime via-lime/40 to-transparent" />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] tracking-[0.28em] text-lime">DAILY REPORT</span>
                    <span className="text-[15px] font-bold text-snow">{current.channelName}</span>
                    {current.whole && <Chip tone="dim">全部歷史</Chip>}
                    {current.range && <Chip tone="blurple">{current.range}</Chip>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-dim">
                      <CalendarDays size={11} />
                      {current.day || "全部"}
                    </span>
                    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-dim">
                      <Clock3 size={11} />
                      {current.modified}
                    </span>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => onOpenChannel(current.channelId, current.offset)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-lime px-3 py-1.5 text-[12.5px] font-bold text-[#101503] transition hover:brightness-110"
                  >
                    <Sparkles size={12} />
                    前往這天的工作區
                  </button>
                  {isRead(current.name) ? (
                    <button
                      onClick={() => { markUnread(current.name); bump((n) => n + 1); }}
                      className="rounded-lg border border-white/[0.09] px-3 py-1.5 text-[12px] text-fog transition hover:text-lime"
                    >
                      標記為未讀
                    </button>
                  ) : (
                    <button
                      onClick={() => { markAllRead([current.name]); bump((n) => n + 1); }}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.09] px-3 py-1.5 text-[12px] text-fog transition hover:border-lime/40 hover:text-lime"
                    >
                      <Check size={12} />
                      標記為已讀
                    </button>
                  )}
                  <span className="flex-1" />
                  <a
                    href={`/api/reports/${encodeURIComponent(current.name)}`}
                    download={current.name}
                    title="下載 .md"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.09] px-3 py-1.5 text-[12px] text-fog transition hover:border-lime/40 hover:text-lime"
                  >
                    <Download size={12} /> 下載
                  </a>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => step(-1)} className="rounded-md border border-white/10 px-2 py-1 font-mono text-[11px] text-fog transition hover:text-lime">
                      ↑ 上一份
                    </button>
                    <button onClick={() => step(1)} className="rounded-md border border-white/10 px-2 py-1 font-mono text-[11px] text-fog transition hover:text-lime">
                      ↓ 下一份
                    </button>
                  </div>
                </div>
              </div>

              <div className="panel mt-4 p-5 md:p-7">
                <SectionLabel>REPORT / {current.name}</SectionLabel>
                {bodyError ? (
                  <div className="mt-3 text-[13px] text-danger">無法讀取此摘要：{bodyError}</div>
                ) : bodyLoading ? (
                  <div className="mt-6 flex items-center gap-2 text-[13px] text-dim">
                    <Loader2 size={14} className="animate-spin" />
                    讀取中…
                  </div>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.28 }}
                    className="mt-3"
                  >
                    <Markdown source={markdown} />
                  </motion.div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export type { ReportItem };
