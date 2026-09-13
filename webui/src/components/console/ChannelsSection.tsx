import { useState } from "react";
import { Check, ExternalLink, Hash, Loader2, Plus, RefreshCw } from "lucide-react";
import { api, type ApiSettings } from "@/lib/api";
import type { ChannelCard } from "@/lib/data";
import { dayInfoForOffset } from "../../lib/format";
import { Chip, SectionLabel } from "../ui";
import { AdminButton, Field, Notice, Toggle, inputCls } from "./widgets";

interface Props {
  settings: ApiSettings;
  channels: ChannelCard[];
  onReload: () => Promise<ApiSettings>;
  onChanged: () => void;
  onOpenChannel: (id: string) => void;
  pushToast: (msg: string, kind?: "ok" | "info" | "danger") => void;
}

/**
 * 頻道管理寫的是 config.json 的監控清單。收集器是獨立行程，但它會自己重讀這份清單，
 * 所以這裡改完不用重啟。
 */
export function ChannelsSection({ settings, channels, onReload, onChanged, onOpenChannel, pushToast }: Props) {
  const [busy, setBusy] = useState("");
  const [addId, setAddId] = useState("");
  const [resolved, setResolved] = useState<{ id: string; name: string; watching: boolean } | null>(null);
  // 查詢時問到的名稱。剛加入的頻道還沒有任何資料，清單裡也就不會有它，
  // 靠這份記住的名稱才不會只顯示 ID。
  const [names, setNames] = useState<Record<string, string>>({});

  const watch = settings.watch;
  const watching = (id: string) => watch.includes(id);

  const persist = async (next: string[], note: string) => {
    setBusy("save");
    try {
      await api.saveSettings({
        llm: {
          baseUrl: settings.llm.baseUrl, model: settings.llm.model, maxChars: settings.llm.maxChars,
          apiKey: "", temperature: settings.llm.temperature ?? 0.3, maxTokens: settings.llm.maxTokens || 4096,
        },
        botToken: "",
        watch: next,
      });
      await onReload();
      pushToast(note, "ok");
      // 收集器幾秒後才會用 REST 問到頻道名稱，所以再讀一次清單，
      // 讓那一列從「只有 ID」變成真正的頻道資料。
      window.setTimeout(onChanged, 8000);
    } catch (err) {
      pushToast(`寫入失敗：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setBusy("");
    }
  };

  const toggle = (id: string, on: boolean) => {
    const next = on ? [...watch, id] : watch.filter((x) => x !== id);
    persist(next, on ? `已加入 ${id}` : `已從清單移除 ${id}`);
  };

  const resolve = async () => {
    const id = addId.trim();
    if (!/^\d+$/.test(id)) {
      pushToast("頻道 ID 應為純數字", "info");
      return;
    }
    setBusy("resolve");
    try {
      const r = await api.resolve(id);
      setResolved({ id: r.id, name: r.name, watching: r.watching });
      if (r.name) setNames((n) => ({ ...n, [r.id]: r.name }));
    } catch (err) {
      setResolved(null);
      pushToast(`找不到該頻道：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setBusy("");
    }
  };

  // A channel that is being watched but has no data yet, or was collected before.
  const known = new Map(channels.map((c) => [c.id, c]));
  const rows = [
    ...channels,
    ...watch.filter((id) => !known.has(id)).map((id) => ({
      id,
      key: id,
      name: names[id] ?? id,
      typeLabel: "",
      watching: true,
      info: dayInfoForOffset(-1),
      count: 0,
      prevCount: 0,
      ratio: 0,
      allTimeTotal: 0,
      hourly: [],
      events: [],
      maxImportance: 0,
      topKeywords: [],
      hasDigest: false,
      lastTs: "",
    } as ChannelCard)),
  ];

  return (
    <div className="space-y-4">
      <SectionLabel right={<Chip tone="dim">{rows.length} 個頻道</Chip>}>CHANNELS / 監控中的頻道</SectionLabel>

      <div className="panel space-y-3 p-5">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <Field label="加入頻道" hint="貼上頻道 ID">
              <input
                className={`${inputCls} font-mono`}
                value={addId}
                onChange={(e) => { setAddId(e.target.value.replace(/\D/g, "")); setResolved(null); }}
                spellCheck={false}
                onKeyDown={(e) => e.key === "Enter" && resolve()}
              />
            </Field>
          </div>
          <AdminButton onClick={resolve} disabled={busy !== "" || addId.length < 5}>
            {busy === "resolve" ? <Loader2 size={13} className="animate-spin" /> : <Hash size={13} />}
            查詢
          </AdminButton>
        </div>
        {resolved && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2">
            <span className="min-w-0 text-[12.5px] text-snow">
              <span className="font-mono text-dim">#{resolved.id}</span> <span className="ml-1">{resolved.name}</span>
            </span>
            {resolved.watching ? (
              <Chip tone="lime"><Check size={10} /> 已在清單</Chip>
            ) : (
              <AdminButton
                primary
                disabled={busy !== ""}
                onClick={() => {
                  const next = [...watch, resolved.id];
                  persist(next, `已加入 ${resolved.name}`);
                  setResolved({ ...resolved, watching: true });
                  setAddId("");
                }}
              >
                <Plus size={13} /> 加入監控
              </AdminButton>
            )}
          </div>
        )}
        <Notice tone="info" icon={<RefreshCw size={12} />}>
          變更寫入 config.json，收集器會自動套用。
        </Notice>
      </div>

      <div className="space-y-2">
        {rows.map((c) => {
          const on = watching(c.id);
          const live = c.allTimeTotal > 0;
          return (
            <div key={c.id} className="panel flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/[0.08] font-mono text-[13px] text-dim">#</span>
              <span className="min-w-[180px] flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-snow">{c.name || c.id}</span>
                  {c.name !== c.id && <span className="shrink-0 font-mono text-[10.5px] text-dim">{c.id}</span>}
                </span>
                <span className="mt-0.5 flex items-center gap-2 font-mono text-[10.5px] text-dim">
                  {live ? <>累計 {c.allTimeTotal.toLocaleString("en-US")} 則 · 最後 {c.lastTs?.slice(5) || "—"}</> : "尚無資料"}
                </span>
              </span>
              <Toggle
                checked={on}
                disabled={busy !== ""}
                onChange={(v) => toggle(c.id, v)}
                label={on ? "監控中" : "停用"}
              />
              <button
                onClick={() => onOpenChannel(c.id)}
                className="rounded-lg border border-white/[0.08] p-1.5 text-dim transition hover:border-lime/40 hover:text-lime"
                title="檢視此頻道"
              >
                <ExternalLink size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
