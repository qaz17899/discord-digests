import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Flame, Megaphone, Waves, Gift, AlertTriangle, Rocket, Mic, Trophy,
  Activity, CheckCircle2, Info, type LucideIcon,
} from "lucide-react";
import type { Author, ApiEventKind } from "@/lib/data";
import { fmtInt } from "@/lib/format";

// ---------------- Avatar ----------------
export function Avatar({ author, size = 32 }: { author: Author; size?: number }) {
  const initial = author.name.replace(/[_.\s]/g, "").slice(0, 1).toUpperCase();
  return (
    <div
      className="relative shrink-0 grid place-items-center font-display font-700 select-none"
      style={{
        width: size, height: size,
        borderRadius: author.bot ? 8 : 999,
        background: `linear-gradient(135deg, hsl(${author.hue} 65% 52% / 0.9), hsl(${(author.hue + 48) % 360} 70% 38% / 0.9))`,
        boxShadow: `0 0 0 1px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.18)`,
        fontSize: size * 0.42, color: "rgba(255,255,255,0.92)", fontWeight: 700,
      }}
    >
      {initial}
    </div>
  );
}

// ---------------- CountUp ----------------
export function CountUp({ value, duration = 900, format = fmtInt, className = "" }: {
  value: number; duration?: number; format?: (n: number) => string; className?: string;
}) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (value - from) * e));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span className={`tabular ${className}`}>{format(display)}</span>;
}

// ---------------- Sparkline ----------------
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0]},${p2[1]}`;
  }
  return d;
}

export function Sparkline({ data, width = 220, height = 40, hot = false, id }: {
  data: number[]; width?: number; height?: number; hot?: boolean; id: string;
}) {
  const gid = id.replace(/[^a-zA-Z0-9]/g, "");
  const max = Math.max(...data, 1);
  const pad = 3;
  const pts: [number, number][] = data.map((v, i) => [
    pad + (i / (data.length - 1)) * (width - pad * 2),
    height - pad - (v / max) * (height - pad * 2),
  ]);
  const line = smoothPath(pts);
  const area = `${line} L ${pts[pts.length - 1][0]},${height} L ${pts[0][0]},${height} Z`;
  const peak = pts[data.indexOf(Math.max(...data))];
  const color = hot ? "#ff6157" : "#b9f34c";
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible" preserveAspectRatio="none">
      <defs>
        <linearGradient id={`sg-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sg-${gid})`} />
      <motion.path
        d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0.4 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        style={{ filter: `drop-shadow(0 0 5px ${color}55)` }}
      />
      <circle cx={peak[0]} cy={peak[1]} r="2.4" fill={color} />
      <circle cx={peak[0]} cy={peak[1]} r="5" fill={color} opacity="0.22" className="pulse-dot" />
    </svg>
  );
}

// ---------------- event kind ----------------
export const EVENT_ICON: Record<ApiEventKind, LucideIcon> = {
  debate: Flame, announce: Megaphone, raid: Waves, drop: Gift,
  outage: AlertTriangle, release: Rocket, ama: Mic, milestone: Trophy, spike: Activity,
};
export const EVENT_COLOR: Record<ApiEventKind, string> = {
  debate: "#ffb020", announce: "#7a7cff", raid: "#ff6157", drop: "#b9f34c",
  outage: "#ff6157", release: "#56d6ff", ama: "#7a7cff", milestone: "#ffb020", spike: "#ff7ad9",
};
export const EVENT_KIND_META: Record<ApiEventKind, string> = {
  debate: "激烈爭論",
  announce: "官方公告",
  raid: "廣告與洗版",
  drop: "抽獎與空投",
  outage: "服務異常",
  release: "版本發布",
  ama: "問答活動",
  milestone: "里程碑",
  spike: "流量異常",
};

export function ImportanceMeter({ level, size = "md" }: { level: number; size?: "sm" | "md" }) {
  const base = size === "sm" ? 4 : 6;
  const step = size === "sm" ? 2.4 : 3.2;
  return (
    <div className="flex items-end gap-[3px]" title={`重要性 ${level}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className={`w-[4px] rounded-[2px] transition-colors ${i <= level ? (level >= 4 ? "bg-danger" : level >= 3 ? "bg-amber" : "bg-lime") : "bg-white/10"}`}
          style={{ height: base + i * step }}
        />
      ))}
    </div>
  );
}

// ---------------- chips & misc ----------------
export function Chip({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "lime" | "amber" | "danger" | "blurple" }) {
  const map = {
    dim: "text-fog border-white/10 bg-white/[0.03]",
    lime: "text-lime border-lime/30 bg-lime/[0.07]",
    amber: "text-amber border-amber/30 bg-amber/[0.07]",
    danger: "text-danger border-danger/30 bg-danger/[0.07]",
    blurple: "text-blurple border-blurple/30 bg-blurple/[0.08]",
  } as const;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium leading-none ${map[tone]}`}>
      {children}
    </span>
  );
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <div className="flex items-center gap-2">
        <span className="micro-label">{"//"}</span>
        <span className="micro-label !text-fog">{children}</span>
      </div>
      {right}
    </div>
  );
}

// ---------------- toasts ----------------
export interface Toast { id: number; msg: string; kind: "ok" | "info" | "danger" }

export function Toaster({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-[90] flex flex-col gap-2 items-end pointer-events-none">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 500, damping: 32 }}
            className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-white/10 bg-panel2/95 backdrop-blur px-3.5 py-2.5 shadow-2xl shadow-black/50"
          >
            {t.kind === "ok" ? (
              <CheckCircle2 size={15} className="text-lime" />
            ) : t.kind === "danger" ? (
              <AlertTriangle size={15} className="text-danger" />
            ) : (
              <Info size={15} className="text-cyan" />
            )}
            <span className="text-[13px] text-snow/90">{t.msg}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
