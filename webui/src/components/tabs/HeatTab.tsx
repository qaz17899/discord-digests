import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Flame, Snowflake, Timer, Link2, Zap } from "lucide-react";
import type { ChannelDay } from "@/lib/data";
import { fmtInt, pad2, hhmm } from "@/lib/format";
import { SectionLabel } from "../ui";
import { EVENT_COLOR } from "../ui";

export function HeatTab({ day }: { day: ChannelDay }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...day.hourly, 1);
  const total = Math.max(1, day.count);

  // hours touched by events
  const eventHours = useMemo(() => {
    const map = new Map<number, string>();
    for (const ev of day.events) {
      for (let m = ev.startMin; m <= ev.endMin; m += 30) {
        map.set(Math.floor(m / 60) % 24, EVENT_COLOR[ev.kind]);
      }
    }
    return map;
  }, [day.events]);

  const gridLines = [0.25, 0.5, 0.75, 1];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      {/* chart */}
      <motion.div
        initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
        className="panel relative self-start p-5 lg:col-span-8"
      >
        <SectionLabel
          right={<span className="font-mono text-[10.5px] tabular text-dim">TOTAL {fmtInt(day.count)}</span>}
        >
          HOURLY DISTRIBUTION / 24 小時訊息分佈
        </SectionLabel>

        <div className="relative mt-2 h-[240px]">
          {/* gridlines */}
          {gridLines.map((g) => (
            <div key={g} className="absolute inset-x-0 border-t border-dashed border-white/[0.06]" style={{ bottom: `${g * 100}%` }}>
              <span className="absolute -top-2 right-0 font-mono text-[9px] tabular text-dim/60">{fmtInt(max * g)}</span>
            </div>
          ))}

          {/* bars */}
          <div className="absolute inset-0 flex items-end gap-[3px] pb-0">
            {day.hourly.map((v, h) => {
              const pct = (v / max) * 100;
              const isPeak = h === day.peakHour;
              const evColor = eventHours.get(h);
              const dimmedFuture = day.info.isToday && h * 60 > day.info.nowMin;
              return (
                <div
                  key={h}
                  className="group relative flex-1 cursor-crosshair"
                  style={{ height: "100%" }}
                  onMouseEnter={() => setHover(h)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div className="absolute inset-x-0 bottom-0 flex h-full items-end">
                    <motion.div
                      initial={{ scaleY: 0 }}
                      animate={{ scaleY: 1 }}
                      transition={{ delay: 0.1 + h * 0.02, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                      className={`w-full origin-bottom rounded-t-[3px] transition-all duration-150 ${
                        isPeak
                          ? "bg-gradient-to-t from-limedim to-lime shadow-[0_0_18px_rgba(185,243,76,0.35)]"
                          : evColor
                            ? "bg-gradient-to-t from-white/[0.08] to-white/[0.22]"
                            : "bg-white/[0.1]"
                      } ${hover === h && !isPeak ? "!bg-blurple/70" : ""} ${dimmedFuture ? "opacity-20" : ""}`}
                      style={{ height: `${Math.max(pct, v > 0 ? 2 : 0.5)}%` }}
                    />
                  </div>
                  {evColor && (
                    <div
                      className="absolute left-1/2 top-1 h-[5px] w-[5px] -translate-x-1/2 rounded-full"
                      style={{ background: evColor, boxShadow: `0 0 8px ${evColor}` }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* tooltip */}
          {hover !== null && (
            <div
              className="pointer-events-none absolute z-20 -translate-x-1/2 rounded-lg border border-white/10 bg-panel3/95 px-3 py-2 shadow-xl shadow-black/50 backdrop-blur"
              style={{ left: `${((hover + 0.5) / 24) * 100}%`, top: 8 }}
            >
              <div className="font-mono text-[11px] font-bold tabular text-snow">{pad2(hover)}:00–{pad2((hover + 1) % 24)}:00</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-display text-[18px] font-700 tabular text-lime" style={{ fontWeight: 700 }}>{fmtInt(day.hourly[hover])}</span>
                <span className="font-mono text-[9.5px] tabular text-dim">{((day.hourly[hover] / total) * 100).toFixed(1)}% of day</span>
              </div>
              {eventHours.get(hover) && (
                <div className="mt-1 flex items-center gap-1 font-mono text-[9px]" style={{ color: eventHours.get(hover) }}>
                  <Zap size={9} /> 事件進行中
                </div>
              )}
            </div>
          )}
        </div>

        {/* x axis */}
        <div className="mt-2 flex justify-between font-mono text-[9.5px] tabular text-dim">
          {["00", "03", "06", "09", "12", "15", "18", "21", "24"].map((t) => <span key={t}>{t}</span>)}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-white/[0.06] pt-3 font-mono text-[10px] text-dim">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px] bg-lime" />峰值時段</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-[5px] w-[5px] rounded-full bg-amber" />事件時段</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-[2px] bg-white/15" />一般流量</span>
          {day.info.isToday && <span className="text-dim/70">今日資料截至 {pad2(Math.floor(day.info.nowMin / 60))}:{pad2(day.info.nowMin % 60)}</span>}
        </div>
      </motion.div>

      {/* side */}
      <div className="space-y-4 lg:col-span-4">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="panel p-4">
          <SectionLabel>PEAK STATS / 峰值指標</SectionLabel>
          <div className="space-y-3">
            {[
              { icon: Flame, tint: "text-lime", label: "峰值時段", value: `${pad2(day.peakHour)}:00 時段`, sub: `${fmtInt(day.hourly[day.peakHour])} 則` },
              { icon: Timer, tint: "text-amber", label: "單分鐘峰值", value: day.stats.peakMinLabel, sub: `${day.stats.peakMinCount} 則 / 分鐘` },
              { icon: Snowflake, tint: "text-cyan", label: "最冷時段", value: `${pad2(day.stats.coldHour)}:00 時段`, sub: `${fmtInt(day.hourly[day.stats.coldHour])} 則` },
            ].map((s) => (
              <div key={s.label} className="flex items-center gap-3 border-b border-white/[0.05] pb-3 last:border-0 last:pb-0">
                <div className={`grid h-8 w-8 place-items-center rounded-lg border border-white/[0.07] bg-white/[0.03] ${s.tint}`}>
                  <s.icon size={14} />
                </div>
                <div className="flex-1">
                  <div className="text-[11px] text-dim">{s.label}</div>
                  <div className="font-mono text-[14px] font-semibold tabular text-snow">{s.value}</div>
                </div>
                <div className="font-mono text-[10.5px] tabular text-fog">{s.sub}</div>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }} className="panel p-4">
          <SectionLabel>TOP DOMAINS / 熱門網域</SectionLabel>
          <div className="space-y-2">
            {day.stats.topDomains.length === 0 && (
              <div className="py-2 text-[12px] text-dim">當日無連結分享紀錄</div>
            )}
            {day.stats.topDomains.map((d, i) => {
              const w = (d.count / (day.stats.topDomains[0]?.count || 1)) * 100;
              return (
                <div key={d.domain} className="group">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="inline-flex items-center gap-1.5 text-fog">
                      <Link2 size={10} className="text-dim" />
                      {d.domain}
                    </span>
                    <span className="font-mono text-[10.5px] tabular text-dim">{fmtInt(d.count)}</span>
                  </div>
                  <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-white/[0.06]">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${w}%` }}
                      transition={{ delay: 0.25 + i * 0.06, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                      className="h-full rounded-full bg-gradient-to-r from-blurple/60 to-blurple"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </motion.div>

        {day.events.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.24 }} className="panel p-4">
            <SectionLabel>EVENT WINDOWS</SectionLabel>
            <div className="space-y-1.5 font-mono text-[11px] tabular">
              {day.events.map((ev) => (
                <div key={ev.id} className="flex items-center gap-2 text-fog">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: EVENT_COLOR[ev.kind] }} />
                  {hhmm(ev.startMin)}–{hhmm(ev.endMin)}
                  <span className="truncate text-dim">{ev.title}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
