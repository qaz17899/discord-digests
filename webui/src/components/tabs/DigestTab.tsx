import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Sparkles, Terminal, Check, Loader2, FileText, ExternalLink,
  FileCode2, AlertTriangle, Trash2, Download,
} from "lucide-react";
import { api } from "@/lib/api";
import { useReportBody, type ChannelDay, type ReportItem } from "@/lib/data";
import type { ApiJob } from "@/lib/api";
import { fmtElapsed, fmtInt } from "@/lib/format";
import { isRead, markRead, onReadChange } from "@/lib/reportRead";
import { SectionLabel, Chip } from "../ui";
import { Markdown, outlineOf } from "../Markdown";

interface DigestTabProps {
  day: ChannelDay;
  job: ApiJob | null;
  llmConfigured: boolean;
  onGenerate: () => void;
  onOpenReport: (channelId: string, dayOffset: number) => void;
  pushToast: (msg: string, kind?: "ok" | "info" | "danger") => void;
  items: ReportItem[];
  reload: () => void;
}

export function DigestTab({ day, job, llmConfigured, onGenerate, onOpenReport, pushToast, items, reload }: DigestTabProps) {
  const running = job?.state === "running";
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [, bump] = useState(0);

  useEffect(() => onReadChange(() => bump((n) => n + 1)), []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 1000);
    return () => clearInterval(t);
  }, [running, startedAt]);

  useEffect(() => {
    if (!running) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, day.hasDigest]);

  /** 這條頻道的摘要，新的在前 —— 歸檔欄就是從這裡來的。 */
  const archive = useMemo(() => items.filter((r) => r.channelId === day.def.id), [items, day.def.id]);
  /** 使用者點的那份；沒點就跟著當日那份摘要走。 */
  const [picked, setPicked] = useState<string | null>(null);
  const current = useMemo(() => {
    const chosen = picked ? archive.find((r) => r.name === picked) : null;
    if (chosen) return chosen;
    return archive.find((r) => r.name === day.digest.name) ?? archive[0] ?? null;
  }, [archive, picked, day.digest.name]);
  const { markdown, loading: bodyLoading } = useReportBody(current?.name ?? null);
  const outline = useMemo(() => (markdown ? outlineOf(markdown) : []), [markdown]);
  /** 讀過就記下來，下一個分頁的未讀數才會跟著動。 */
  useEffect(() => {
    if (current && markdown) markRead(current.name);
  }, [current, markdown, bump]);

  /** 刪掉一份摘要；如果正好在看那份，就退回這天的摘要或清掉選擇。 */
  const remove = async (name: string) => {
    const row = archive.find((r) => r.name === name);
    const label = row ? `${row.label} ${row.range || (row.whole ? "全部歷史" : "全天")}` : name;
    try {
      await api.deleteReport(name);
      setPicked((p) => (p === name ? null : p));
      reload();
      pushToast(`已刪除 ${label} 的摘要`, "ok");
    } catch (err) {
      pushToast(`刪除失敗：${err instanceof Error ? err.message : err}`, "danger");
    }
  };

  if (running) {
    return <PipelinePanel day={day} job={job!} elapsed={elapsed} llmConfigured={llmConfigured} />;
  }

  if (job?.state === "error") {
    return (
      <div className="mx-auto max-w-[720px]">
        <div className="panel border-danger/30 p-5">
          <div className="flex items-center gap-2 text-danger">
            <AlertTriangle size={15} />
            <span className="font-mono text-[11px] tracking-[0.2em]">DIGEST FAILED</span>
          </div>
          <p className="mt-3 text-[13.5px] leading-relaxed text-fog">{job.message}</p>
          <button
            onClick={onGenerate}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] px-3.5 py-2 text-[13px] text-fog transition hover:border-lime/40 hover:text-lime"
          >
            <Sparkles size={14} />
            再試一次
          </button>
        </div>
      </div>
    );
  }

  // Nothing written for this day but the channel has older reports: keep the
  // archive reachable, and let the reader open whichever row is picked.
  if (!current) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[248px_1fr]">
        <ArchiveColumn archive={archive} currentName="" day={day} onPick={setPicked} onDelete={remove} />
        <div className="min-w-0">
          <div className="grid place-items-center rounded-2xl border border-dashed border-white/15 px-6 py-16 text-center">
            <div className={`grid h-14 w-14 place-items-center rounded-2xl border ${day.hasInput ? "border-cyan/25 bg-cyan/[0.06]" : "border-amber/25 bg-amber/[0.06]"}`}>
              {day.hasInput ? <FileCode2 size={22} className="text-cyan" /> : <FileText size={22} className="text-amber" />}
            </div>
            <div className="mt-5 text-[16px] font-bold text-snow">
              {day.hasInput ? "輸入檔已備妥，尚未產生摘要" : `#${day.def.name} · ${day.info.key} 的摘要尚未產生`}
            </div>
            <p className="mt-2 max-w-[460px] text-[13px] leading-relaxed text-dim">
              當日共 {fmtInt(day.count)} 則訊息、{day.events.length} 起事件、{day.authors.length} 位發言者。
              {day.hasInput
                ? " 輸入檔已涵蓋此區間完整文字內容；於「控制台 → AI 連線」完成模型設定後即可直接產生摘要。"
                : " 產生摘要時會先進行無損壓縮（過濾無效字元、整合短訊息、整理網址附錄），再分批傳送至模型處理。"}
            </p>
            {day.hasInput && (
              <a
                href={`/api/channels/${encodeURIComponent(day.def.id)}/input?from=${day.info.key}&to=${day.info.key}`}
                target="_blank"
                rel="noreferrer"
                className="mt-3 font-mono text-[11px] text-cyan/80 underline decoration-dotted transition hover:text-cyan"
              >
                {day.digest.inputName} — 檢視提供給模型的原始輸入檔
              </a>
            )}
            <button
              onClick={onGenerate}
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-lime px-5 py-2.5 text-[14px] font-bold text-[#101503] shadow-[0_0_28px_rgba(185,243,76,0.28)] transition hover:shadow-[0_0_40px_rgba(185,243,76,0.45)] hover:brightness-110 active:scale-[0.97]"
            >
              <Sparkles size={15} />
              {llmConfigured ? "產生今日摘要" : "準備摘要輸入"}
            </button>
            <span className="mt-3 font-mono text-[10px] tracking-wider text-dim">
              {llmConfigured ? "依照批次呼叫模型，完成後將自動呈現於此" : "未設定模型：僅輸出輸入檔 · 20k 則約需一至兩分鐘"}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[248px_1fr]">
      <ArchiveColumn archive={archive} currentName={current.name} day={day} onPick={setPicked} onGenerate={onGenerate} onDelete={remove} />

      <div className="min-w-0">
        <motion.div
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
          className="panel relative overflow-hidden p-5 md:p-7"
        >
          <div className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-lime via-lime/40 to-transparent" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] tracking-[0.28em] text-lime">DIGEST</span>
              <span className="font-mono text-[12px] font-bold tabular text-snow">
                {current.whole ? "全部歷史" : current.label}
                {current.weekday && <span className="ml-1 text-dim">{current.weekday}</span>}
              </span>
              {current.range && <Chip tone="blurple">{current.range}</Chip>}
              {!isRead(current.name) && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-lime" />}
              {current.day && current.day !== day.info.key && (
                <button
                  onClick={() => onOpenReport(current.channelId, current.offset)}
                  className="rounded-md border border-white/12 px-2 py-0.5 text-[11px] text-fog transition hover:border-lime/40 hover:text-lime"
                >
                  切到這天的工作區
                </button>
              )}
            </div>
            <a
              href={`/api/reports/${encodeURIComponent(current.name)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[10px] text-dim transition hover:text-lime"
            >
              {current.name}
              <ExternalLink size={10} />
            </a>
            <a
              href={`/api/reports/${encodeURIComponent(current.name)}`}
              download={current.name}
              title="下載 .md"
              className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] px-2 py-1 font-mono text-[10px] text-dim transition hover:border-lime/40 hover:text-lime"
            >
              <Download size={10} /> 下載
            </a>
          </div>

          {outline.length > 1 && (
            <div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.015] p-3">
              <SectionLabel>OUTLINE / 段落</SectionLabel>
              <div className="mt-1.5 space-y-0.5">
                {outline.map((s) => (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      const el = document.getElementById(s.id) ?? headingWithText(s.text);
                      el?.scrollIntoView({ behavior: "smooth", block: "center" });
                    }}
                    className={`flex items-baseline gap-2 rounded px-2 py-1 text-[12.5px] transition hover:bg-white/[0.04] hover:text-lime ${
                      s.level === 3 ? "pl-6 text-dim" : "text-fog"
                    }`}
                  >
                    <span className="font-mono text-[9.5px] text-dim/60">{s.level === 2 ? "§" : "·"}</span>
                    <span className="min-w-0 flex-1 truncate">{s.text}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {bodyLoading ? (
            <div className="mt-6 flex items-center gap-2 text-[13px] text-dim">
              <Loader2 size={14} className="animate-spin" />讀取中…
            </div>
          ) : (
            <div className="mt-4">
              <Markdown source={markdown} />
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

/** The channel's report archive: replaces the old right-hand rail. */
function ArchiveColumn({ archive, currentName, day, onPick, onGenerate, onDelete }: {
  archive: ReportItem[];
  currentName: string;
  day: ChannelDay;
  onPick: (name: string) => void;
  onGenerate?: () => void;
  onDelete: (name: string) => void;
}) {
  const unread = archive.filter((r) => !isRead(r.name)).length;
  /** 要刪哪一份——點垃圾桶先在列內問一次，不用跳系統對話框。 */
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <aside className="panel flex max-h-[78vh] flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3.5 py-2.5">
        <span className="micro-label !text-[9.5px]">ARCHIVE / {archive.length} 份</span>
        <span className="font-mono text-[9.5px] tabular text-dim">{unread} 未讀</span>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {archive.length === 0 && (
          <p className="px-3 py-6 text-center text-[12.5px] text-dim">此頻道目前無任何摘要</p>
        )}
        {archive.map((r) => {
          const active = r.name === currentName;
          const read = isRead(r.name);
          if (r.name === confirming) {
            return (
              <div key={r.name} className="flex items-center justify-between gap-2 rounded-lg bg-danger/[0.07] px-2.5 py-2">
                <span className="min-w-0 truncate text-[12px] text-fog">刪除 {r.label}？</span>
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => { setConfirming(null); onDelete(r.name); }}
                    className="rounded-md border border-danger/40 bg-danger/15 px-2 py-0.5 text-[11.5px] font-bold text-danger transition hover:bg-danger/25"
                  >
                    刪除
                  </button>
                  <button
                    onClick={() => setConfirming(null)}
                    className="rounded-md border border-white/[0.12] px-2 py-0.5 text-[11.5px] text-dim transition hover:text-fog"
                  >
                    取消
                  </button>
                </span>
              </div>
            );
          }
          return (
            <button
              key={r.name}
              onClick={() => onPick(r.name)}
              className={`group relative flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                active ? "bg-lime/[0.08]" : "hover:bg-white/[0.035]"
              }`}
              title={r.name}
            >
              {active && <span className="absolute left-0 top-1/2 h-6 w-[2px] -translate-y-1/2 rounded-full bg-lime" />}
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${read ? "bg-white/15" : "bg-lime pulse-dot"}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={`font-mono text-[11.5px] font-bold tabular ${active ? "text-lime" : "text-snow/85"}`}>
                    {r.label}
                  </span>
                  <span className="font-mono text-[9.5px] text-dim">{r.weekday}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className={`font-mono text-[10px] ${r.range ? "text-blurple" : "text-dim"}`}>
                    {r.range || (r.whole ? "全部歷史" : "全天")}
                  </span>
                  <span className="font-mono text-[9px] text-dim/70">{Math.round(r.size / 1024)} KB</span>
                </div>
              </div>
              <span
                role="button"
                tabIndex={-1}
                title="刪除這份摘要"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirming(r.name);
                }}
                className="mt-0.5 hidden shrink-0 rounded-md p-1 text-dim/70 transition hover:bg-danger/15 hover:text-danger group-hover:block"
              >
                <Trash2 size={12} />
              </span>
            </button>
          );
        })}
      </div>
      {!day.hasDigest && onGenerate && (
        <button
          onClick={onGenerate}
          className="m-1.5 flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-lime/30 py-2 text-[12px] text-lime transition hover:bg-lime/[0.06]"
        >
          <Sparkles size={12} />
          產生 {day.info.labelShort} 摘要
        </button>
      )}
      {currentName && (
        <div className="border-t border-white/[0.06] px-3.5 py-2">
          <button
            onClick={() => markRead(currentName)}
            className="inline-flex items-center gap-1.5 font-mono text-[10px] text-dim transition hover:text-lime"
          >
            <Check size={10} />
            標記為已讀
          </button>
        </div>
      )}
    </aside>
  );
}
function headingWithText(text: string): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>(".report-md h2, .report-md h3");
  for (const n of nodes) if ((n.textContent ?? "").includes(text)) return n;
  return null;
}

/** Live view of the running summarizer job. Every number comes from the job. */
function PipelinePanel({ day, job, elapsed, llmConfigured }: {
  day: ChannelDay; job: ApiJob; elapsed: number; llmConfigured: boolean;
}) {
  const batches = job.batches;
  const pct = batches > 0 ? Math.round((job.done / batches) * 100) : 0;
  const stages = [
    { label: `取出 ${fmtInt(day.count)} 則訊息並無損壓縮`, state: "done" as const },
    {
      label: llmConfigured
        ? batches > 0 ? `分批送進模型（第 ${job.done} / ${batches} 批）` : "切分批次…"
        : "輸出摘要輸入檔（未設定模型）",
      state: llmConfigured ? (batches > 0 && job.done >= batches ? "done" : "now") : "now",
    },
    { label: "輸出摘要", state: "wait" as const },
  ];

  return (
    <div className="mx-auto max-w-[720px]">
      <div className="panel relative overflow-hidden p-6">
        <div className="scan-line absolute left-0 right-0 h-16 bg-gradient-to-b from-transparent via-lime/[0.06] to-transparent" />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-lime">
            <Terminal size={15} />
            <span className="font-mono text-[11px] tracking-[0.2em]">DIGEST PIPELINE</span>
          </div>
          <span className="font-mono text-[11px] tabular text-dim">{fmtElapsed(elapsed)}</span>
        </div>
        <div className="mt-5 space-y-2.5 font-mono text-[12.5px]">
          {stages.map((s, i) => (
            <div key={i} className="flex items-center gap-2.5">
              {s.state === "done" ? (
                <Check size={13} className="text-lime" />
              ) : s.state === "now" ? (
                <Loader2 size={13} className="animate-spin text-amber" />
              ) : (
                <span className="w-[13px] text-center text-dim">·</span>
              )}
              <span className={s.state === "done" ? "text-fog" : s.state === "now" ? "text-snow" : "text-dim"}>{s.label}</span>
            </div>
          ))}
          <div className="pt-1 text-lime caret-blink">▊</div>
        </div>
        <div className="mt-5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
          <motion.div
            className="h-full rounded-full bg-gradient-to-r from-limedim to-lime"
            animate={{ width: `${pct}%` }}
            transition={{ ease: "easeOut", duration: 0.5 }}
          />
        </div>
        <div className="mt-3 font-mono text-[10px] tracking-wider text-dim">{job.message}</div>
      </div>
    </div>
  );
}


