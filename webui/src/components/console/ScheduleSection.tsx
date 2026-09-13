import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Check, Clock, Loader2, Play, Save } from "lucide-react";
import { api, type ApiSchedule, type ApiScheduleState, type ApiSettings } from "@/lib/api";
import type { ChannelCard } from "@/lib/data";
import { Chip, SectionLabel } from "../ui";
import { AdminButton, Field, Notice, Toggle, inputCls } from "./widgets";

interface Props {
  settings: ApiSettings;
  channels: ChannelCard[];
  pushToast: (msg: string, kind?: "ok" | "info" | "danger") => void;
}

const OFFSETS: { v: number; label: string }[] = [
  { v: 0, label: "今天" },
  { v: 1, label: "昨天" },
  { v: 2, label: "前天" },
];

export function ScheduleSection({ settings, channels, pushToast }: Props) {
  const [state, setState] = useState<ApiScheduleState | null>(null);
  const [sched, setSched] = useState<ApiSchedule>(settings.schedule);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const s = await api.schedule();
      setState(s);
      setSched(s.schedule);
    } catch (err) {
      pushToast(`讀取排程失敗：${err instanceof Error ? err.message : err}`, "danger");
    }
  }, [pushToast]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy("save");
    try {
      const next = await api.saveSchedule(sched);
      setState(next);
      pushToast(next.schedule.enabled ? `已啟用，下次執行 ${next.nextRun || "（無法計算）"}` : "已停用排程", "ok");
    } catch (err) {
      pushToast(`儲存失敗：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setBusy("");
    }
  };

  const targets = sched.targets ?? [];
  const toggleTarget = (id: string) => {
    const next = targets.includes(id) ? targets.filter((x) => x !== id) : [...targets, id];
    setSched({ ...sched, targets: next });
  };

  return (
    <div className="space-y-4">
      <SectionLabel
        right={
          state?.nextRun ? <Chip tone="lime">下次 {state.nextRun.slice(5, 16)}</Chip> : <Chip tone="dim">未啟用</Chip>
        }
      >
        SCHEDULE / 自動排程
      </SectionLabel>

      <div className="panel space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Toggle
            checked={sched.enabled}
            onChange={(v) => setSched({ ...sched, enabled: v })}
            label={sched.enabled ? "啟用中" : "停用"}
          />
          <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-dim">
            <Clock size={10} /> GMT+8
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="模式">
            <div className="flex gap-1.5">
              {(["daily", "interval"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setSched({ ...sched, mode: m })}
                  className={`flex-1 rounded-lg border px-3 py-2 text-[12.5px] transition ${
                    sched.mode === m ? "border-lime/40 bg-lime/10 text-lime" : "border-white/[0.08] text-dim hover:text-fog"
                  }`}
                >
                  {m === "daily" ? "每天定時" : "固定間隔"}
                </button>
              ))}
            </div>
          </Field>

          {sched.mode === "daily" ? (
            <Field label="執行時間" hint="HH:MM">
              <input
                className={`${inputCls} font-mono`}
                value={sched.time}
                onChange={(e) => setSched({ ...sched, time: e.target.value })}
                placeholder="08:30"
                spellCheck={false}
              />
            </Field>
          ) : (
            <Field label="間隔（小時）">
              <input
                className={`${inputCls} font-mono`}
                value={sched.intervalH}
                onChange={(e) => setSched({ ...sched, intervalH: Number(e.target.value.replace(/\D/g, "")) || 1 })}
                inputMode="numeric"
              />
            </Field>
          )}
        </div>

        <Field label="摘要基準日" hint="產生整日（00:00~23:59）摘要">
          <div className="flex gap-1.5">
            {OFFSETS.map((o) => (
              <button
                key={o.v}
                onClick={() => setSched({ ...sched, offsetDays: o.v })}
                className={`rounded-lg border px-3 py-1.5 text-[12px] transition ${
                  sched.offsetDays === o.v ? "border-lime/40 bg-lime/10 text-lime" : "border-white/[0.08] text-dim hover:text-fog"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </Field>

        <Toggle
          checked={sched.weekdaysOnly}
          onChange={(v) => setSched({ ...sched, weekdaysOnly: v })}
          label="僅限工作日（週一至週五）"
        />

        <Field label="目標頻道" hint={targets.length ? `已選 ${targets.length} 個` : "未指定則包含所有監控中頻道"}>
          <div className="flex flex-wrap gap-1.5">
            {channels.map((c) => {
              const on = targets.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggleTarget(c.id)}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] transition ${
                    on ? "border-lime/40 bg-lime/10 text-lime" : "border-white/[0.08] text-dim hover:border-white/20 hover:text-fog"
                  }`}
                >
                  {on && <Check size={10} />}
                  {c.name || c.id}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
          <AdminButton primary onClick={save} disabled={busy !== ""}>
            {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            儲存排程
          </AdminButton>
          <AdminButton onClick={load} disabled={busy !== ""}>
            <Play size={13} /> 重新載入
          </AdminButton>
          {state?.lastNote && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-dim">
              <CalendarClock size={10} /> {state.lastNote}
            </span>
          )}
        </div>

        <Notice tone="warn">
          排程產生之摘要將儲存於 <span className="font-mono">reports/</span> 並顯示於對應頻道的「摘要」分頁中。若尚未設定模型，則僅匯出摘要輸入檔。
        </Notice>
      </div>

      {state?.recent && state.recent.length > 0 && (
        <>
          <SectionLabel>RECENT / 最近的排程執行</SectionLabel>
          <div className="panel divide-y divide-white/[0.05] p-2">
            {state.recent.slice(0, 12).map((r) => (
              <div key={r.key} className="flex items-center justify-between gap-3 px-3 py-2 font-mono text-[11px]">
                <span className="text-fog">{r.day}</span>
                <span className="min-w-0 flex-1 truncate text-dim">{r.channelId}</span>
                <span className="text-lime">{r.at}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
