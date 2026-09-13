import type { ReactNode } from "react";

// The control room's small parts. Everything here is presentation only: the
// data always comes from the API, never from a local default.

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-medium text-fog">{label}</span>
        {hint && <span className="min-w-0 truncate font-mono text-[9.5px] text-dim">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-white/[0.09] bg-ink px-3 py-2 text-[13px] text-snow placeholder:text-dim/60 outline-none transition focus:border-lime/50 focus:ring-2 focus:ring-lime/15";

export const selectCls = `${inputCls} appearance-none`;

export function Toggle({
  checked, onChange, label, disabled = false,
}: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2.5 disabled:opacity-50"
    >
      <span
        className={`relative h-[20px] w-[36px] rounded-full border transition-colors duration-200 ${
          checked ? "border-lime/50 bg-lime/20" : "border-white/15 bg-white/[0.05]"
        }`}
      >
        <span
          className={`absolute top-1/2 h-[14px] w-[14px] -translate-y-1/2 rounded-full transition-all duration-200 ${
            checked ? "left-[19px] bg-lime shadow-[0_0_10px_rgba(185,243,76,0.6)]" : "left-[3px] bg-dim"
          }`}
        />
      </span>
      {label && <span className={`text-[12.5px] transition-colors ${checked ? "text-snow" : "text-dim"}`}>{label}</span>}
    </button>
  );
}

export function AdminButton({
  children, onClick, primary = false, danger = false, disabled = false, className = "", title,
}: {
  children: ReactNode; onClick?: () => void; primary?: boolean; danger?: boolean;
  disabled?: boolean; className?: string; title?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition active:scale-[0.97] disabled:opacity-45 disabled:pointer-events-none";
  const skin = primary
    ? "bg-lime text-[#101503] font-bold shadow-[0_0_22px_rgba(185,243,76,0.22)] hover:shadow-[0_0_32px_rgba(185,243,76,0.4)] hover:brightness-110"
    : danger
      ? "border border-danger/30 text-danger hover:bg-danger/10"
      : "border border-white/[0.1] text-fog hover:border-white/25 hover:text-snow";
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled} className={`${base} ${skin} ${className}`}>
      {children}
    </button>
  );
}

/** Slider with a value readout; `format` renders the number for humans. */
export function Slider({
  label, value, min, max, step = 1, onChange, format,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-fog">{label}</span>
        <span className="font-mono text-[11px] text-lime">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/[0.08] accent-lime
                   [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none
                   [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-lime
                   [&::-webkit-slider-thumb]:shadow-[0_0_10px_rgba(185,243,76,0.5)]"
      />
      <div className="mt-1 flex justify-between font-mono text-[9.5px] text-dim">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

export function Notice({
  tone = "info", icon, children,
}: { tone?: "info" | "warn" | "ok"; icon?: ReactNode; children: ReactNode }) {
  const skin = {
    info: "border-cyan/25 bg-cyan/[0.05] text-cyan",
    warn: "border-amber/25 bg-amber/[0.06] text-amber",
    ok: "border-lime/25 bg-lime/[0.05] text-lime",
  }[tone];
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed ${skin}`}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function KeyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-[11.5px] text-dim">{label}</span>
      <span className="min-w-0 text-right text-[12px] text-fog">{children}</span>
    </div>
  );
}
