// 24 小時訊息分佈圖與時間範圍選取器，用於媒體圖片庫依時段篩選圖片。
// 數據來源為當日訊息分佈（/summary 的 hourly）與事件（events）。

import { useRef } from "react";
import { Zap } from "lucide-react";

interface HourRangeProps {
  hourly: number[];
  value: [number, number];
  onChange: (v: [number, number]) => void;
  /** Hours that contain an event — drawn as a marker above the bars. */
  eventHours?: number[];
}

const PRESETS: [string, number, number][] = [
  ["全部", 0, 24],
  ["00–06", 0, 6],
  ["06–12", 6, 12],
  ["12–18", 12, 18],
  ["18–24", 18, 24],
];

export function HourRange({ hourly, value, onChange, eventHours = [] }: HourRangeProps) {
  const [start, end] = value;
  const peak = Math.max(1, ...hourly);
  const bars = useRef<HTMLDivElement | null>(null);

  /** Clicking a bar moves whichever handle is closer, so one click narrows it. */
  const pickHour = (h: number) => {
    const toStart = Math.abs(h - start);
    const toEnd = Math.abs(h - (end - 1));
    if (toStart <= toEnd) onChange([Math.min(h, end - 1), end]);
    else onChange([start, Math.max(h + 1, start + 1)]);
  };

  const inRange = (h: number) => h >= start && h < end;

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.015] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="micro-label !text-[9.5px]">TIME WINDOW / 時間範圍</span>
          <span className="font-mono text-[11.5px] font-bold tabular text-lime">
            {String(start).padStart(2, "0")}:00 → {String(end).padStart(2, "0")}:00
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {PRESETS.map(([label, a, b]) => {
            const on = a === start && b === end;
            return (
              <button
                key={label}
                onClick={() => onChange([a, b])}
                className={`rounded-md border px-2 py-0.5 font-mono text-[10.5px] transition ${
                  on ? "border-lime/45 bg-lime/[0.1] text-lime" : "border-white/[0.08] text-dim hover:text-fog"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div ref={bars} className="relative flex h-[46px] items-end gap-[2px]">
        {hourly.map((n, h) => {
          const on = inRange(h);
          const hasEvent = eventHours.includes(h);
          return (
            <button
              key={h}
              onClick={() => pickHour(h)}
              title={`${String(h).padStart(2, "0")}:00 · ${n} 則`}
              className="group relative flex-1"
              style={{ height: "100%" }}
            >
              {hasEvent && (
                <span className="absolute -top-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-amber" />
              )}
              <span
                className={`absolute bottom-0 left-0 right-0 rounded-t-[2px] transition-colors ${
                  on ? "bg-limedim/80 group-hover:bg-lime" : "bg-white/[0.09] group-hover:bg-white/20"
                }`}
                style={{ height: `${Math.max(3, (n / peak) * 38)}px` }}
              />
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={23}
          value={start}
          data-hour-start
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange([Math.min(v, end - 1), end]);
          }}
          className="hour-slider"
          aria-label="起始小時"
        />
        <input
          type="range"
          min={1}
          max={24}
          value={end}
          data-hour-end
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange([start, Math.max(v, start + 1)]);
          }}
          className="hour-slider"
          aria-label="結束小時"
        />
      </div>

      {eventHours.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[9.5px] text-amber/80">
          <Zap size={9} />
          {eventHours.length} 個事件時段（{eventHours.map((h) => String(h).padStart(2, "0")).join(", ")} 時）
        </div>
      )}
    </div>
  );
}

export { PRESETS as HOUR_PRESETS };
