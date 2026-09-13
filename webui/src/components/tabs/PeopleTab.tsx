import { motion } from "framer-motion";
import { MessageSquare, Reply, Heart, Crown } from "lucide-react";
import type { ChannelDay, AuthorStat } from "@/lib/data";
import { fmtInt } from "@/lib/format";
import { Avatar, SectionLabel } from "../ui";

const BOARDS = [
  { key: "top", title: "發言總量排行", sub: "發言訊息數最多", icon: MessageSquare, tint: "#b9f34c", crownLabel: "發言第一" },
  { key: "replied", title: "被回覆次數排行", sub: "被其他成員回覆最多", icon: Reply, tint: "#56d6ff", crownLabel: "回覆第一" },
  { key: "reacted", title: "表情反應排行", sub: "獲得表情反應最多", icon: Heart, tint: "#ff7ad9", crownLabel: "互動第一" },
] as const;

export function PeopleTab({ day }: { day: ChannelDay }) {
  const lists: Record<(typeof BOARDS)[number]["key"], AuthorStat[]> = {
    top: day.stats.topAuthors,
    replied: day.stats.mostReplied,
    reacted: day.stats.mostReacted,
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <SectionLabel>LEADERBOARDS / 活躍成員統計</SectionLabel>
        <span className="font-mono text-[10.5px] tabular text-dim">活躍成員 {day.authors.length} 人</span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {BOARDS.map((b, bi) => {
          const list = lists[b.key];
          const top = Math.max(1, list[0]?.count ?? 1);
          return (
            <motion.div
              key={b.key}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: bi * 0.08, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              className="panel p-4"
            >
              <div className="flex items-center gap-2.5 border-b border-white/[0.06] pb-3">
                <div className="grid h-8 w-8 place-items-center rounded-lg border border-white/[0.07]" style={{ color: b.tint, background: `${b.tint}0f` }}>
                  <b.icon size={14} />
                </div>
                <div>
                  <div className="text-[13.5px] font-bold text-snow">{b.title}</div>
                  <div className="text-[10.5px] text-dim">{b.sub}</div>
                </div>
              </div>

              <div className="mt-2 space-y-0.5">
                {list.length === 0 && <div className="px-2 py-6 text-center text-[12px] text-dim">當日尚無資料</div>}
                {list.map((s, i) => (
                  <motion.div
                    key={s.author.id + b.key}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.15 + bi * 0.08 + i * 0.04, duration: 0.35 }}
                    className={`group relative flex items-center gap-2.5 rounded-lg px-2 py-2 ${i === 0 ? "bg-white/[0.04]" : "hover:bg-white/[0.025]"}`}
                  >
                    <span className={`w-4 text-right font-mono text-[11px] tabular ${i === 0 ? "font-bold" : "text-dim"}`} style={i === 0 ? { color: b.tint } : undefined}>
                      {i + 1}
                    </span>
                    <div className="relative">
                      <Avatar author={s.author} size={26} />
                      {i === 0 && (
                        <Crown size={11} className="absolute -right-1 -top-1.5 rotate-12" style={{ color: b.tint }} fill={b.tint} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={`truncate text-[13px] font-bold ${i === 0 ? "text-snow" : "text-snow/80"}`}>
                          {s.author.name}
                          {s.author.bot && <span className="ml-1 rounded bg-blurple/20 px-1 font-mono text-[8px] text-blurple">BOT</span>}
                        </span>
                        <span className="font-mono text-[11px] tabular text-fog">{fmtInt(s.count)}</span>
                      </div>
                      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-white/[0.06]">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${(s.count / top) * 100}%` }}
                          transition={{ delay: 0.3 + i * 0.05, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                          className="h-full rounded-full"
                          style={{ background: `linear-gradient(90deg, ${b.tint}55, ${b.tint})` }}
                        />
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>

              <div className="mt-3 border-t border-white/[0.06] pt-2.5 text-center font-mono text-[10px] tracking-wider text-dim">
                NO.1 · {b.crownLabel}
              </div>            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
