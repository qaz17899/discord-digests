import { motion } from "framer-motion";
import { Crosshair, Radar, MessageSquare, Heart, Clock3, Link2, Users, Quote } from "lucide-react";
import type { ChannelDay, EventItem } from "@/lib/data";
import { hhmm, tsHHMM, fmtInt } from "@/lib/format";
import { Avatar, EVENT_ICON, EVENT_COLOR, EVENT_KIND_META, ImportanceMeter, SectionLabel } from "../ui";

export function EventsTab({ day, jumpTo }: { day: ChannelDay; jumpTo: (idx: number) => void }) {
  if (day.events.length === 0) {
    return (
      <div className="grid place-items-center rounded-2xl border border-dashed border-white/12 py-24 text-center">
        <Radar size={24} className="text-dim" />
        <div className="mt-4 text-[15px] font-bold text-snow/90">當日未偵測到事件</div>
        <p className="mt-1.5 max-w-[420px] text-[12.5px] leading-relaxed text-dim">
          #{day.def.name} 在 {day.info.key} 的 {fmtInt(day.count)} 則訊息中，
          無任何 10 分鐘區間明顯超過當日基準（關鍵字密集出現、表情反應暴增或流量突增）。
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[860px]">
      <SectionLabel
        right={<span className="font-mono text-[10.5px] tabular text-dim">{day.events.length} EVENTS · MAX LVL {day.maxImportance}</span>}
      >
        EVENT TIMELINE / 事件時間軸
      </SectionLabel>

      <div>
        {day.events.map((ev, i) => (
          <EventRow key={ev.id} ev={ev} index={i} last={i === day.events.length - 1} jumpTo={jumpTo} />
        ))}
      </div>

      <p className="mt-6 border-t border-white/[0.06] pt-4 text-[11.5px] leading-relaxed text-dim">
        事件偵測機制：10 分鐘區間內若出現關鍵字密集討論、表情反應暴增或訊息量顯著高於當日中位數，
        系統即會彙整為一項事件並標註類型。每項事件均附上觸發的原始訊息以供查證。
      </p>
    </div>
  );
}

function EventRow({ ev, index, last, jumpTo }: {
  ev: EventItem; index: number; last: boolean; jumpTo: (idx: number) => void;
}) {
  const Icon = EVENT_ICON[ev.kind];
  const color = EVENT_COLOR[ev.kind];
  const dur = ev.endMin - ev.startMin + 1;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 8) * 0.08, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="grid grid-cols-[62px_28px_1fr]"
    >
      {/* time rail */}
      <div className="pt-4 text-right">
        <div className="font-mono text-[13px] font-semibold tabular text-snow/90">{hhmm(ev.startMin)}</div>
        <div className="mt-0.5 flex items-center justify-end gap-1 font-mono text-[9.5px] text-dim">
          <Clock3 size={9} />
          {dur}m
        </div>
      </div>

      {/* spine */}
      <div className="relative flex justify-center">
        {!(index === 0 && last) && (
          <div
            className="absolute w-px bg-gradient-to-b from-white/12 via-white/[0.07] to-white/12"
            style={{ top: index === 0 ? 27 : 0, bottom: last ? "calc(100% - 27px)" : 0 }}
          />
        )}
        <div
          className="relative z-10 mt-[18px] grid h-[18px] w-[18px] place-items-center rounded-full border"
          style={{ borderColor: `${color}66`, background: "#0b0e13", boxShadow: `0 0 12px ${color}44` }}
        >
          <div className={`h-[7px] w-[7px] rounded-full ${ev.importance >= 4 ? "pulse-dot" : ""}`} style={{ background: color }} />
        </div>
      </div>

      {/* card */}
      <div className="pb-5 pl-1">
        <div className="panel glow-hover p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-bold"
              style={{ color, borderColor: `${color}44`, background: `${color}14` }}
            >
              <Icon size={12} />
              {EVENT_KIND_META[ev.kind]}
            </span>
            <span className="font-mono text-[10.5px] tabular text-dim">
              {hhmm(ev.startMin)}–{hhmm(ev.endMin)}
            </span>
            <span className="flex-1" />
            <ImportanceMeter level={ev.importance} size="sm" />
          </div>

          <h3 className="mt-2.5 text-[16px] font-bold tracking-tight text-snow">{ev.title}</h3>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fog">{ev.desc}</p>

          {ev.keywords.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {ev.keywords.map((k) => (
                <span key={k} className="rounded-md bg-white/[0.05] px-2 py-0.5 font-mono text-[10.5px] text-fog">{k}</span>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-white/[0.06] pt-3 font-mono text-[11px] tabular text-dim">
            <span className="inline-flex items-center gap-1.5">
              <MessageSquare size={11} className="text-fog" />
              {fmtInt(ev.msgCount)} 則
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Heart size={11} className="text-fog" />
              {fmtInt(ev.reactionTotal)} 反應
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Users size={11} className="text-fog" />
              {fmtInt(ev.authors)} 人
            </span>
            {ev.links > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <Link2 size={11} className="text-fog" />
                {fmtInt(ev.links)} 連結
              </span>
            )}
            <span>峰值 {hhmm(ev.peakMin)}</span>
          </div>

          {/* the messages that triggered this event */}
          <div className="mt-3 space-y-2">
            <div className="micro-label !text-[9px]">EVIDENCE / 觸發訊息</div>
            {ev.evidence.map((e, i) => (
              <div key={e.id + i} className="rounded-lg border border-white/[0.06] bg-ink/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar author={e.author} size={22} />
                    <span className="truncate text-[12.5px] font-bold" style={{ color: `hsl(${e.author.hue} 70% 72%)` }}>
                      {e.author.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] tabular text-dim">{tsHHMM(e.ts)}</span>
                    {e.reactions > 0 && (
                      <span className="shrink-0 font-mono text-[10px] tabular text-fog">♥ {fmtInt(e.reactions)}</span>
                    )}
                  </div>
                  {e.idx >= 0 && (
                    <button
                      onClick={() => jumpTo(e.idx)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[10.5px] text-fog transition hover:border-lime/50 hover:text-lime"
                    >
                      <Crosshair size={11} />
                      定位原文
                    </button>
                  )}
                </div>
                <div className="mt-1.5 flex items-start gap-1.5">
                  <Quote size={11} className="mt-1 shrink-0 text-dim/60" />
                  <p className="line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-snow/80">{e.content}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
