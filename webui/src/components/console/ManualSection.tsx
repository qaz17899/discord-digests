import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock3, FileText, Hash,
  Loader2, Send, Sparkles, Wand2, ExternalLink,
} from "lucide-react";
import { api, type ApiEvent, type ApiJob, type ApiLab, type ApiSettings } from "@/lib/api";
import type { ChannelCard } from "@/lib/data";
import { useReports } from "@/lib/data";
import { fmtInt, pad2 } from "@/lib/format";
import { Chip, SectionLabel } from "../ui";
import { AdminButton, Field, KeyRow, Notice, selectCls } from "./widgets";

interface Props {
  channels: ChannelCard[];
  settings: ApiSettings;
  onOpenChannel: (id: string) => void;
  pushToast: (msg: string, kind?: "ok" | "info" | "danger") => void;
}

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hhmm = (min: number) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

const DAY_PRESETS = [
  { label: "今天", delta: 0 },
  { label: "昨天", delta: 1 },
  { label: "前天", delta: 2 },
  { label: "上週同日", delta: 7 },
];

const RANGE_PRESETS: { label: string; from: number; to: number }[] = [
  { label: "全日", from: 0, to: 1440 },
  { label: "白天 09–18", from: 540, to: 1080 },
  { label: "晚間 18–24", from: 1080, to: 1440 },
  { label: "深夜 00–06", from: 0, to: 360 },
];

/** Two range inputs drive one window; the bars behind them are real hourly counts. */
function TimeWindow({
  hourly, fromMin, toMin, onChange,
}: { hourly: number[]; fromMin: number; toMin: number; onChange: (from: number, to: number) => void }) {
  const peak = Math.max(1, ...hourly);
  return (
    <div>
      <div className="relative flex h-14 items-end gap-[2px] rounded-lg border border-white/[0.06] bg-black/25 p-1.5">
        {Array.from({ length: 24 }, (_, h) => {
          const inside = h * 60 >= fromMin && h * 60 < toMin;
          const v = hourly[h] ?? 0;
          return (
            <div key={h} className="flex h-full flex-1 flex-col justify-end" title={`${pad2(h)}:00 · ${fmtInt(v)} 則`}>
              <div
                className={`w-full rounded-sm transition-colors ${inside ? "bg-lime/70" : "bg-white/12"}`}
                style={{ height: `${Math.max(v / peak * 100, v > 0 ? 4 : 1)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="relative mt-2 h-3">
        <input
          type="range" min={0} max={1440} step={30} value={fromMin}
          onChange={(e) => onChange(Math.min(Number(e.target.value), toMin - 30), toMin)}
          className="pointer-events-none absolute inset-0 h-3 w-full appearance-none bg-transparent
                     [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
                     [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-lime
                     [&::-webkit-slider-thumb]:shadow-[0_0_10px_rgba(185,243,76,0.5)]"
        />
        <input
          type="range" min={0} max={1440} step={30} value={toMin}
          onChange={(e) => onChange(fromMin, Math.max(Number(e.target.value), fromMin + 30))}
          className="pointer-events-none absolute inset-0 h-3 w-full appearance-none bg-transparent
                     [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
                     [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan
                     [&::-webkit-slider-thumb]:shadow-[0_0_10px_rgba(88,196,220,0.5)]"
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-1 rounded-full bg-gradient-to-r from-lime/60 to-cyan/60" />
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-[11px]">
        <span className="text-lime">{hhmm(fromMin)}</span>
        <span className="text-dim">{hhmm(toMin)}</span>
      </div>
    </div>
  );
}

export function ManualSection({ channels, settings, onOpenChannel, pushToast }: Props) {
  const today = useMemo(() => localDay(new Date()), []);
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");  const [day, setDay] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return localDay(d);
  });
  const [fromMin, setFromMin] = useState(0);
  const [toMin, setToMin] = useState(1440);
  const [lab, setLab] = useState<ApiLab | null>(null);
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState<ApiJob | null>(null);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<"system" | "user">("user");
  const [expand, setExpand] = useState(false);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  const channel = channels.find((c) => c.id === channelId);
  const { items: reportItems } = useReports();
  /** 選的這天這頻道已有幾份摘要 —— 讓人知道不必重跑。 */
  const existingReports = useMemo(
    () => reportItems.filter((r) => r.channelId === channelId && r.day === day),
    [reportItems, channelId, day],
  );

  // 頻道清單是非同步來的，第一次 render 通常是空的：等它到了要自動選第一個，
  // 否則 channelId 一直是空字串，這一頁會默默什麼都不做。
  useEffect(() => {
    if (!channelId && channels.length > 0) setChannelId(channels[0].id);
  }, [channelId, channels]);

  // The window is converted to the exact instants the API wants.
  const fromTs = `${day}T${hhmm(fromMin)}`;
  const toTs = `${day}T${hhmm(toMin === 1440 ? 1439 : toMin)}`;

  const load = useCallback(async () => {
    if (!channelId) return;
    setLoading(true);
    try {
      const data = await api.lab(channelId, fromTs, toTs);
      setLab(data);
    } catch (err) {
      pushToast(`讀取範圍失敗：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setLoading(false);
    }
  }, [channelId, fromTs, toTs, pushToast]);

  useEffect(() => {
    const t = setTimeout(load, 250); // a slider drag should not fire one request per pixel
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => () => { if (poll.current) clearTimeout(poll.current); }, []);

  // 盯著一份工作到結束。自己按的、以及切頁回來接上的都走這裡，
  // 所以「完成」的提示只寫一次。
  const watchJob = useCallback(
    async (id: string, alive?: () => boolean) => {
      const j = await api.job(id);
      if (alive && !alive()) return;
      setJob(j);
      if (j.state === "running") {
        poll.current = setTimeout(() => watchJob(id, alive), 1500);
        return;
      }
      setRunning(false);
      if (j.state === "done") pushToast(`完成：${j.message}`, "ok");
      else if (j.state === "input") pushToast("已備妥輸入檔（還沒設定模型）", "info");
      else pushToast(j.message, "danger");
    },
    [pushToast],
  );

  // 切到別頁再回來時，這份工作還在 serve 裡跑：接回進度，不要重新開始。
  const windowFrom = fromTs.replace("T", " ") + ":00";
  const windowTo = toTs.replace("T", " ") + ":00";
  useEffect(() => {
    if (!channelId) return;
    let alive = true;
    api
      .jobs()
      .then((jobs) => {
        const mine = jobs.find(
          (j) => j.state === "running" && j.channelId === channelId && j.from === windowFrom && j.to === windowTo,
        );
        if (!alive || !mine) return;
        setJob(mine);
        setRunning(true);
        poll.current = setTimeout(() => watchJob(mine.id, () => alive), 1200);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (poll.current) clearTimeout(poll.current);
    };
  }, [channelId, windowFrom, windowTo, watchJob]);

  const run = async () => {
    setRunning(true);
    setJob(null);
    try {
      const started = await api.startDigest(channelId, fromTs, toTs);
      setJob(started);
      if (started.state === "running") poll.current = setTimeout(() => watchJob(started.id), 1200);
      else setRunning(false);
    } catch (err) {
      setRunning(false);
      pushToast(`無法開始：${err instanceof Error ? err.message : err}`, "danger");
    }
  };

  const eventRange = (e: ApiEvent) => {
    setFromMin(Math.max(0, e.startMin));
    setToMin(Math.min(1440, e.endMin));
  };

  const tokens = lab?.tokens;
  const budgetMax = Math.max(1, tokens?.user ?? 1);
  const promptText = lab?.prompts ? (tab === "system" ? lab.prompts.system : lab.prompts.user) : "";

  /**
   * 預覽只送得回開頭 20000 字（一次 70 萬字的 JSON 沒意義），所以「展開全部」
   * 要真的再跟後端要一次完整的那一批，而不是把前端已經收到的字串切大一點。
   */
  const [full, setFull] = useState<{ key: string; text: string } | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const fullKey = `${channelId}|${fromTs}|${toTs}`;
  const toggleExpand = async () => {
    if (expand) {
      setExpand(false);
      return;
    }
    setExpand(true);
    if (tab !== "user" || !lab?.prompts?.truncated || full?.key === fullKey) return;
    setLoadingFull(true);
    try {
      const data = await api.lab(channelId, fromTs, toTs, true);
      setFull({ key: fullKey, text: data.prompts?.user ?? "" });
    } finally {
      setLoadingFull(false);
    }
  };
  const promptShown =
    tab === "user" && expand && lab?.prompts?.truncated
      ? loadingFull
        ? "讀取完整內容…"
        : full?.key === fullKey
          ? full.text
          : promptText
      : expand || promptText.length < 20000
        ? promptText
        : promptText.slice(0, 20000) + "\n\n…（這裡只顯示開頭，按「展開全部」載入完整內容）";

  return (
    <div className="space-y-4">
      <SectionLabel
        right={
          lab && !lab.empty ? (
            <Chip tone="lime">{fmtInt(lab.messages)} 則</Chip>
          ) : lab?.empty ? (
            <Chip tone="amber">這個範圍沒有訊息</Chip>
          ) : null
        }
      >
        MANUAL DIGEST / 手動摘要
      </SectionLabel>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* ---------------------------------------------------- left: controls */}
        <div className="space-y-4">
          <div className="panel space-y-4 p-5">
            <Field label="目標頻道">
              <select className={selectCls} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>{c.name || c.id}</option>
                ))}
              </select>
            </Field>
            {channel && (
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-dim">
                <Hash size={10} />{channel.id}
                {channel.allTimeTotal > 0 && <span>· 累計 {fmtInt(channel.allTimeTotal)} 則</span>}
                {channel.lastTs && <span>· 最後 {channel.lastTs.slice(5, 16)}</span>}
              </div>
            )}

            <Field label="日期">
              <div className="flex flex-wrap gap-1.5">
                {DAY_PRESETS.map((p) => {
                  const d = new Date();
                  d.setDate(d.getDate() - p.delta);
                  const value = localDay(d);
                  const on = value === day;
                  return (
                    <button
                      key={p.label}
                      onClick={() => setDay(value)}
                      className={`rounded-lg border px-2.5 py-1.5 text-[11.5px] transition ${
                        on ? "border-lime/40 bg-lime/10 text-lime" : "border-white/[0.08] text-dim hover:text-fog"
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <input
                type="date"
                className="mt-2 w-full rounded-lg border border-white/[0.09] bg-ink px-3 py-2 font-mono text-[12.5px] text-snow outline-none transition focus:border-lime/50"
                value={day}
                max={today}
                onChange={(e) => setDay(e.target.value)}
              />
            </Field>
          </div>

          <div className="panel space-y-3 p-5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-fog">
                <Clock3 size={12} /> 時間範圍
              </span>
              <span className="font-mono text-[10.5px] text-dim">{loading ? "讀取中…" : lab?.range ?? ""}</span>
            </div>
            <TimeWindow hourly={lab?.hourly ?? new Array(24).fill(0)} fromMin={fromMin} toMin={toMin}
              onChange={(f, t) => { setFromMin(f); setToMin(t); }} />
            <div className="flex flex-wrap gap-1.5">
              {RANGE_PRESETS.map((p) => {
                const on = fromMin === p.from && toMin === p.to;
                return (
                  <button
                    key={p.label}
                    onClick={() => { setFromMin(p.from); setToMin(p.to); }}
                    className={`rounded-md border px-2 py-1 text-[11px] transition ${
                      on ? "border-lime/40 bg-lime/10 text-lime" : "border-white/[0.08] text-dim hover:text-fog"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            {lab && (lab.events?.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <span className="text-[11px] text-dim">事件時段（點擊套用該事件時間範圍）</span>
                <div className="flex flex-wrap gap-1.5">
                  {lab.events!.slice(0, 6).map((e) => (
                    <button
                      key={e.id}
                      onClick={() => eventRange(e)}
                      title={e.desc}
                      className="inline-flex items-center gap-1 rounded-md border border-amber/25 bg-amber/[0.06] px-2 py-1 text-[10.5px] text-amber transition hover:bg-amber/15"
                    >
                      <AlertTriangle size={9} />
                      {hhmm(e.startMin)} {e.keywords?.[0] ?? e.kind}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-3">
              {[
                { label: "範圍內訊息", value: lab ? fmtInt(lab.messages) : "—" },
                { label: "作者", value: lab?.authors !== undefined ? fmtInt(lab.authors) : "—" },
                { label: "重點事件", value: lab?.events ? String(lab.events.length) : "—" },
              ].map((s) => (
                <div key={s.label}>
                  <div className="text-[15px] font-bold tabular text-snow">{s.value}</div>
                  <div className="font-mono text-[9.5px] text-dim">{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel space-y-3 p-5">
            <div className="flex items-center justify-between font-mono text-[10.5px]">
              <span className="text-dim">{settings.llm.model || "未設定模型"}{settings.llm.baseUrl ? ` @ ${(() => { try { return new URL(settings.llm.baseUrl).host; } catch { return settings.llm.baseUrl; } })()}` : ""}</span>
              <span className="text-dim">{lab ? `${lab.batches} 批 × ${fmtInt(lab.maxChars ?? 0)} 字` : ""}</span>
            </div>
            {existingReports.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-lime/20 bg-lime/[0.05] px-2.5 py-2 text-[11px] text-fog">
                <FileText size={11} className="shrink-0 text-lime" />
                <span>這天已有 {existingReports.length} 份摘要</span>
                {existingReports.map((r) => (
                  <span key={r.name} className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[10px] text-dim">
                    {r.range || (r.whole ? "全部歷史" : "全天")}
                  </span>
                ))}
              </div>
            )}
            <AdminButton primary className="w-full" onClick={run} disabled={running || !channelId || lab?.empty}>
              {running ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {running ? "摘要進行中…" : "產生摘要"}
            </AdminButton>
            {job && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between font-mono text-[10.5px]">
                  <span className={job.state === "error" ? "text-danger" : job.state === "done" ? "text-lime" : "text-fog"}>
                    {job.state === "input" ? "已備妥輸入檔" : job.message}
                  </span>
                  {job.batches > 0 && <span className="text-dim">{job.done}/{job.batches}</span>}
                </div>
                {job.batches > 0 && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                    <div className="h-full rounded-full bg-lime transition-all" style={{ width: `${(job.done / job.batches) * 100}%` }} />
                  </div>
                )}
                {job.report && (
                  <button
                    onClick={() => onOpenChannel(channelId)}
                    className="inline-flex items-center gap-1 text-[11.5px] text-lime transition hover:underline"
                  >
                    <ExternalLink size={11} /> 檢視摘要：{job.report}
                  </button>
                )}
              </div>
            )}
            {!settings.llm.baseUrl && (
              <Notice tone="warn" icon={<Wand2 size={12} />}>
                尚未設定模型：執行後僅會產出 <span className="font-mono">.input.txt</span>（提供給模型的文字內容），不發送 API 請求。
              </Notice>
            )}
          </div>
        </div>

        {/* ---------------------------------------------------- right: prompt */}
        <div className="space-y-4">
          <div className="panel p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-white/[0.08] px-2 py-0.5 font-mono text-[10.5px] text-dim">POST</span>
              <span className="font-mono text-[11.5px] text-fog">
                {settings.llm.baseUrl ? `${(() => { try { return new URL(settings.llm.baseUrl).host + new URL(settings.llm.baseUrl).pathname; } catch { return settings.llm.baseUrl; } })()}/chat/completions` : "（未設定端點）"}
              </span>
              <span className="ml-auto flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-dim">
                <span>model {settings.llm.model || "—"}</span>
                <span>temp {settings.llm.temperature ?? 0.3}</span>
                <span>max_tokens {fmtInt(settings.llm.maxTokens || 4096)}</span>
              </span>
            </div>
            {lab?.prompts && (
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-1.5">
                  <FileText size={12} className="text-dim" />
                  <span className="text-[11.5px] text-dim">
                    {tab === "system" ? "系統提示詞" : "實際送出的使用者訊息（第 1 批）"}
                    <span className="text-dim/70"> · {lab.prompts.userLines.toLocaleString("en-US")} 行</span>
                    {tab === "user" && lab.prompts.userChars > lab.prompts.user.length && (
                      <span className="text-dim/70"> · 全長 {fmtInt(lab.prompts.userChars)} 字，這裡只顯示開頭 {fmtInt(lab.prompts.user.length)} 字</span>
                    )}
                  </span>
                  <button
                    onClick={toggleExpand}
                    className="ml-auto inline-flex items-center gap-1 rounded border border-white/12 px-1.5 py-0.5 font-mono text-[10.5px] text-fog transition hover:border-lime/40 hover:text-lime"
                  >
                    {expand ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                    {expand ? "收合" : lab.prompts.truncated ? "展開全部" : "展開"}
                  </button>
                </div>
                <div className="flex gap-1.5">
                  {(["system", "user"] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setTab(k)}
                      className={`rounded-md border px-2 py-1 font-mono text-[10.5px] uppercase transition ${
                        tab === k ? "border-lime/40 bg-lime/10 text-lime" : "border-white/[0.08] text-dim hover:text-fog"
                      }`}
                    >
                      {k} · {fmtInt(k === "system" ? lab.tokens?.system ?? 0 : lab.tokens?.user ?? 0)} tok
                    </button>
                  ))}
                </div>
                <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.06] bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed text-fog">
                  {promptShown}
                </pre>
              </div>
            )}
            {!lab && <div className="py-10 text-center text-[12px] text-dim">選擇頻道與時間範圍…</div>}
          </div>

          {lab?.tokens && (
            <div className="panel space-y-3 p-5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-fog">
                  <Sparkles size={12} /> Token 預算
                </span>
                <span className="font-mono text-[10.5px] text-dim">
                  {fmtInt(lab.tokens.user)} / 批 · 估算值
                </span>
              </div>
              <div className="flex h-2 overflow-hidden rounded-full bg-white/[0.07]">
                <div className="bg-cyan" style={{ width: `${(lab.tokens.system / budgetMax) * 100}%` }} />
                <div className="bg-lime" style={{ width: `${((lab.tokens.user - lab.tokens.system) / budgetMax) * 100}%` }} />
              </div>
              <div className="grid gap-2 font-mono text-[10.5px] text-dim sm:grid-cols-3">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-cyan" />system {fmtInt(lab.tokens.system)}</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-lime" />user {fmtInt(lab.tokens.user)}</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-white/30" />每批 {fmtInt(lab.tokens.perBatch)}</span>
              </div>
              <div className="space-y-1.5 border-t border-white/[0.06] pt-3">
                <KeyRow label="送出的訊息">{fmtInt(lab.included ?? lab.messages)} / {fmtInt(lab.messages)} 則（全部送出）</KeyRow>
                <KeyRow label="壓縮後字元數">{fmtInt(lab.compressedChars ?? 0)}</KeyRow>
                <KeyRow label="批次">{lab.batches} 批（每批 {fmtInt(lab.maxChars ?? 0)} 字）</KeyRow>
                <KeyRow label="附件 / 連結 / 表情">{fmtInt(lab.media ?? 0)} / {fmtInt(lab.links ?? 0)} / {fmtInt(lab.reactions ?? 0)}</KeyRow>
              </div>
            </div>
          )}

          {lab?.empty && (
            <Notice tone="warn" icon={<CheckCircle2 size={12} />}>
              所選範圍內無訊息，請切換日期或擴大時間範圍。
            </Notice>
          )}
        </div>
      </div>
    </div>
  );
}
