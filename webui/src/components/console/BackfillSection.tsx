import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, CalendarRange, CheckCircle2, DownloadCloud, ExternalLink, Hash, Loader2, WifiOff, X,
} from "lucide-react";
import { api, type ApiBackfillJob, type ApiWatch } from "@/lib/api";
import type { ChannelCard } from "@/lib/data";
import { fmtInt } from "@/lib/format";
import { Chip, SectionLabel } from "../ui";
import { AdminButton, Field, KeyRow, Notice, inputCls } from "./widgets";

interface Props {
  channels: ChannelCard[];
  onOpenChannel: (id: string) => void;
  pushToast: (msg: string, kind?: "ok" | "info" | "danger") => void;
}

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A GMT+8 window "YYYY-MM-DDTHH:MM", which is what the API takes. */
const windowAt = (daysAgo: number, end = false) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${localDay(d)}T${end ? "23:59" : "00:00"}`;
};

/** 現在時間到分，datetime-local 的格式。 */
const nowAt = () => {
  const d = new Date();
  return `${localDay(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const PRESETS = [
  { label: "今天", from: windowAt(0), to: nowAt() },
  { label: "昨天", from: windowAt(1), to: windowAt(1, true) },
  { label: "最近 3 天", from: windowAt(3), to: windowAt(1, true) },
  { label: "最近 7 天", from: windowAt(7), to: windowAt(1, true) },
  { label: "最近 30 天", from: windowAt(30), to: windowAt(1, true) },
];

const MAX_DAYS = 30;

/** Every GMT+8 day the window touches; days are the unit of work. */
function windowDays(from: string, to: string): string[] {
  const out: string[] = [];
  const end = to.slice(0, 10);
  const d = new Date(`${from.slice(0, 10)}T00:00:00`);
  while (localDay(d) <= end) {
    out.push(localDay(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

const STATE_LABEL: Record<ApiBackfillJob["state"], string> = {
  request: "排隊中",
  running: "回補中",
  done: "完成",
  error: "有失敗",
  cancelled: "已取消",
};

const STATE_TONE: Record<ApiBackfillJob["state"], "dim" | "lime" | "amber" | "danger" | "blurple"> = {
  request: "dim",
  running: "blurple",
  done: "lime",
  error: "amber",
  cancelled: "dim",
};

function dayCellClass(job: ApiBackfillJob, channel: string, day: string) {
  const unit = job.done?.[channel]?.[day];
  if (unit?.err) return "border-danger/40 bg-danger/20 text-danger";
  if (unit) return unit.added > 0 ? "border-lime/45 bg-lime/25 text-lime" : "border-white/12 bg-white/[0.07] text-dim";
  if (job.current?.some((c) => c.channel === channel && c.day === day)) return "border-cyan/50 bg-cyan/20 text-cyan animate-pulse";
  return "border-white/[0.07] text-dim/50";
}

export function BackfillSection({ channels, onOpenChannel, pushToast }: Props) {
  const [picked, setPicked] = useState<string[] | null>(null);
  const [from, setFrom] = useState(PRESETS[0].from);
  const [to, setTo] = useState(PRESETS[0].to);
  const [recent, setRecent] = useState<ApiBackfillJob[]>([]);
  const [watch, setWatch] = useState<ApiWatch | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // The channel list arrives asynchronously; until the operator picks something
  // by hand, the selection is "everything currently being watched".
  const selected = picked ?? channels.filter((c) => c.watching).map((c) => c.id);
  const watchedIds = useMemo(() => channels.filter((c) => c.watching).map((c) => c.id), [channels]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const [status, jobs] = await Promise.all([api.status(), api.backfills()]);
        if (!alive) return;
        setWatch(status.watch);
        setRecent(jobs);
      } catch {
        // The API is restarting or busy; the next tick retries.
      }
      if (alive) timer = setTimeout(tick, 3000);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const days = windowDays(from, to);
  const tooLong = days.length > MAX_DAYS;
  const active = recent.find((j) => j.state === "running" || j.state === "request");
  const shown = (focusId && recent.find((j) => j.id === focusId)) || active || recent[0];
  const busy = !!active;
  const localTotal = channels.filter((c) => selected.includes(c.id)).reduce((n, c) => n + c.allTimeTotal, 0);

  const toggle = (id: string) =>
    setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const start = async () => {
    setStarting(true);
    try {
      const job = await api.startBackfill(selected, from, to);
      setFocusId(job.id);
      setRecent((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      pushToast("已排入佇列，收集器會在幾秒內接手", "ok");
    } catch (err) {
      pushToast(`無法開始：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await api.cancelBackfill(id);
      pushToast("已送出取消", "info");
    } catch (err) {
      pushToast(`${err instanceof Error ? err.message : err}`, "danger");
    }
  };

  const pct = shown && shown.totals.units > 0 ? (shown.totals.done / shown.totals.units) * 100 : 0;

  return (
    <div className="space-y-4">
      <SectionLabel
        right={
          watch?.online ? (
            <Chip tone="lime">收集器上線 · pid {watch.pid}</Chip>
          ) : (
            <Chip tone="amber">收集器離線</Chip>
          )
        }
      >
        HISTORY BACKFILL / 歷史回補
      </SectionLabel>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* --------------------------------------------------- left: request */}
        <div className="space-y-4">
          <div className="panel space-y-4 p-5">
            <Field label="目標頻道" hint={`${selected.length}/${channels.length} 已選`}>
              <div className="space-y-1.5">
                {channels.length === 0 && <div className="text-[12px] text-dim">還沒有任何頻道</div>}
                {channels.map((c) => {
                  const on = selected.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      onClick={() => toggle(c.id)}
                      className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition ${
                        on ? "border-lime/40 bg-lime/[0.07]" : "border-white/[0.07] hover:border-white/15"
                      }`}
                    >
                      <span
                        className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                          on ? "border-lime bg-lime/25 text-lime" : "border-white/20"
                        }`}
                      >
                        {on && <CheckCircle2 size={10} />}
                      </span>
                      <span className={`min-w-0 flex-1 truncate text-[12.5px] ${on ? "text-snow" : "text-fog"}`}>
                        {c.name || c.id}
                      </span>
                      <span className="shrink-0 font-mono text-[9.5px] text-dim">{fmtInt(c.allTimeTotal)}</span>
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setPicked(watchedIds)}
                className="rounded-md border border-white/[0.08] px-2 py-1 text-[11px] text-dim transition hover:text-fog"
              >
                只選監控中
              </button>
              <button
                onClick={() => setPicked(channels.map((c) => c.id))}
                className="rounded-md border border-white/[0.08] px-2 py-1 text-[11px] text-dim transition hover:text-fog"
              >
                全選
              </button>
              <button
                onClick={() => setPicked([])}
                className="rounded-md border border-white/[0.08] px-2 py-1 text-[11px] text-dim transition hover:text-fog"
              >
                全不選
              </button>
            </div>
          </div>

          <div className="panel space-y-3 p-5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-fog">
                <CalendarRange size={12} /> 時間範圍
              </span>
              <span className={`font-mono text-[10.5px] ${tooLong ? "text-danger" : "text-dim"}`}>
                {days.length} 天 / 上限 {MAX_DAYS}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => {
                const on = p.from === from && p.to === to;
                return (
                  <button
                    key={p.label}
                    onClick={() => {
                      setFrom(p.from);
                      setTo(p.to);
                    }}
                    className={`rounded-md border px-2 py-1 text-[11px] transition ${
                      on ? "border-lime/40 bg-lime/10 text-lime" : "border-white/[0.08] text-dim hover:text-fog"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="開始">
                <input type="datetime-local" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="結束">
                <input type="datetime-local" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </div>
            <div className="space-y-1.5 border-t border-white/[0.06] pt-3">
              <KeyRow label="工作項目">{days.length * selected.length}（{days.length} 天 × {selected.length} 頻道）</KeyRow>
              <KeyRow label="選中頻道累計">{fmtInt(localTotal)} 則</KeyRow>
            </div>
          </div>

          <div className="panel space-y-3 p-5">
            <AdminButton
              primary
              className="w-full"
              onClick={start}
              disabled={starting || busy || tooLong || selected.length === 0}
            >
              {starting ? <Loader2 size={14} className="animate-spin" /> : <DownloadCloud size={14} />}
              開始回補
            </AdminButton>
            {!watch?.online && (
              <Notice tone="warn" icon={<WifiOff size={12} />}>
                收集器未執行。排隊中的工作將於啟動後執行，或可透過命令列執行：
                <span className="font-mono"> discordwatch backfill -queued</span>
              </Notice>
            )}
            {tooLong && (
              <Notice tone="warn" icon={<AlertTriangle size={12} />}>
                範圍最多 {MAX_DAYS} 天，目前選了 {days.length} 天。
              </Notice>
            )}
            <Notice tone="info" icon={<Hash size={12} />}>
              可取得：訊息、附件、回覆關聯、表情數量與編輯後之最新內容；無法取得：已刪除訊息、編輯前歷史、以及按下表情之成員清單。本機既有訊息將比對內容，僅於變更時覆寫。
            </Notice>
          </div>
        </div>

        {/* -------------------------------------------------- right: progress */}
        <div className="space-y-4">
          {shown ? (
            <div className="panel space-y-4 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={STATE_TONE[shown.state]}>{STATE_LABEL[shown.state]}</Chip>
                <span className="font-mono text-[11px] text-dim">
                  {shown.from.replace("T", " ")} → {shown.to.replace("T", " ")}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  {shown.state === "request" || shown.state === "running" ? (
                    <AdminButton danger onClick={() => cancel(shown.id)}>
                      <X size={12} /> 取消
                    </AdminButton>
                  ) : (
                    <button
                      onClick={() => onOpenChannel(shown.channels[0])}
                      className="inline-flex items-center gap-1 text-[11.5px] text-lime transition hover:underline"
                    >
                      <ExternalLink size={11} /> 檢視訊息
                    </button>
                  )}
                </span>
              </div>

              <div>
                <div className="mb-1.5 flex items-baseline justify-between font-mono text-[10.5px]">
                  <span className="text-fog">
                    {shown.totals.done} / {shown.totals.units} 天
                  </span>
                  <span className="text-dim">
                    {shown.totals.msgsPerMin > 0 && `${fmtInt(shown.totals.msgsPerMin)} 則/分`}
                    {shown.state === "running" && shown.totals.etaMin > 0 && ` · 剩約 ${shown.totals.etaMin} 分`}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                  <div
                    className={`h-full rounded-full transition-all ${shown.state === "error" ? "bg-amber" : shown.state === "cancelled" ? "bg-dim" : "bg-lime"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  { label: "新增", value: shown.totals.added },
                  { label: "覆寫", value: shown.totals.updated },
                  { label: "未變", value: shown.totals.skipped },
                  { label: "請求次數", value: shown.totals.pages },
                ].map((s) => (
                  <div key={s.label}>
                    <div className="text-[15px] font-bold tabular text-snow">{fmtInt(s.value)}</div>
                    <div className="font-mono text-[9.5px] text-dim">{s.label}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-2 border-t border-white/[0.06] pt-3">
                {shown.channels.map((channelId) => {
                  const name = channels.find((c) => c.id === channelId)?.name || channelId;
                  const plan = windowDays(shown.from, shown.to);
                  return (
                    <div key={channelId} className="space-y-1">
                      <div className="truncate text-[11.5px] text-fog">{name}</div>
                      <div className="flex flex-wrap gap-[3px]">
                        {plan.map((day) => {
                          const unit = shown.done?.[channelId]?.[day];
                          const title = unit
                            ? `${day}　新增 ${unit.added}、覆寫 ${unit.updated}、未變 ${unit.skipped}（${unit.pages} 次請求，${(unit.ms / 1000).toFixed(1)} 秒）${unit.err ? `　錯誤：${unit.err}` : ""}`
                            : `${day}　${shown.current?.some((c) => c.channel === channelId && c.day === day) ? "進行中" : "未開始"}`;
                          return (
                            <span
                              key={day}
                              title={title}
                              className={`h-3.5 w-3.5 rounded-sm border ${dayCellClass(shown, channelId, day)}`}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {shown.current && shown.current.length > 0 && (
                <div className="space-y-1 border-t border-white/[0.06] pt-3 font-mono text-[10.5px] text-dim">
                  {shown.current.map((c) => (
                    <div key={`${c.channel}-${c.day}`} className="flex items-center justify-between gap-3">
                      <span className="truncate text-cyan">
                        {c.day} · {channels.find((x) => x.id === c.channel)?.name || c.channel}
                      </span>
                      <span className="shrink-0">
                        {c.pages} 頁 · 新增 {c.added} · 覆寫 {c.updated}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {shown.message && <div className="text-[11.5px] text-fog">{shown.message}</div>}
            </div>
          ) : (
            <div className="panel grid place-items-center p-10 text-[12px] text-dim">
              請選擇時間範圍並點擊開始，即可將 Discord 歷史訊息回補至本機檔案。
            </div>
          )}

          {recent.length > 1 && (
            <div className="panel p-5">
              <div className="mb-3 text-[12px] font-medium text-fog">最近的工作</div>
              <div className="space-y-1">
                {recent.slice(0, 12).map((j) => (
                  <button
                    key={j.id}
                    onClick={() => setFocusId(j.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition ${
                      j.id === shown?.id ? "border-lime/30 bg-lime/[0.06]" : "border-transparent hover:bg-white/[0.03]"
                    }`}
                  >
                    <Chip tone={STATE_TONE[j.state]}>{STATE_LABEL[j.state]}</Chip>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-dim">
                      {j.from.replace("T", " ")} → {j.to.replace("T", " ")} · {j.channels.length} 頻道
                    </span>
                    <span className="shrink-0 font-mono text-[10.5px] text-fog">
                      {j.totals.done}/{j.totals.units} · +{fmtInt(j.totals.added)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
