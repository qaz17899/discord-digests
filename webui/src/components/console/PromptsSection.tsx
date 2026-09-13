import { useMemo, useState } from "react";
import { Loader2, RotateCcw, Save, ScrollText, Wand2 } from "lucide-react";
import { api, type ApiSettings } from "@/lib/api";
import type { ChannelCard } from "@/lib/data";
import { Chip, SectionLabel } from "../ui";
import { AdminButton, Field, Notice, inputCls } from "./widgets";

// The same substitution the backend does (digest.go renderTemplate), so the
// preview matches what will be sent.
const VARS = ["channel", "range", "count", "index", "total", "body", "partials"];

function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{([a-zA-Z]+)\}\}/g, (m, key: string) => (key in vars ? vars[key] : m));
}

interface Props {
  settings: ApiSettings;
  channels: ChannelCard[];
  onReload: () => Promise<ApiSettings>;
  pushToast: (msg: string, kind?: "ok" | "info" | "danger") => void;
}

export function PromptsSection({ settings, channels, onReload, pushToast }: Props) {
  const [system, setSystem] = useState(settings.prompts.system || settings.defaultPrompts.system);
  const [user, setUser] = useState(settings.prompts.user || settings.defaultPrompts.user);
  const [reduce, setReduce] = useState(settings.prompts.reduce || settings.defaultPrompts.reduce);
  const [busy, setBusy] = useState("");
  const [which, setWhich] = useState<"system" | "user" | "reduce">("system");

  const dirty =
    system !== (settings.prompts.system || settings.defaultPrompts.system) ||
    user !== (settings.prompts.user || settings.defaultPrompts.user) ||
    reduce !== (settings.prompts.reduce || settings.defaultPrompts.reduce);

  // Preview uses the sample values the digest would fill in; the body is
  // shortened because the real one is a megabyte.
  const preview = useMemo(() => {
    const sampleBody =
      "── 2026-09-10 ──\n[09:00] GoForceX: pro：嘻嘻，我一定要活下去\n" +
      "[09:04] MarinaX: 又一個模型說自己是 V4 (#1)\n" +
      "[09:11] 天汉: 官方公告出來了 (#2)\n…（真實執行時這裡是整個範圍的訊息本體）";
    const vars = {
      channel: channels[0]?.name ?? "頻道名稱",
      range: "2026-09-10 09:00 ~ 23:00",
      count: "14,995",
      index: "1",
      total: "13",
      body: sampleBody,
      partials: "# 部分摘要 1\n…（合併階段會拿到各批次的摘要）",
    };
    return {
      system,
      user: render(user, vars),
      reduce: reduce === "{{partials}}" ? render(reduce, vars) : reduce,
    }[which];
  }, [which, system, user, reduce, channels]);

  const save = async () => {
    setBusy("save");
    try {
      // A field that still matches the built-in text is stored as empty, so
      // "back to built-in" really clears it instead of freezing today's default.
      const norm = (v: string, d: string) => (v.trim() === d.trim() ? "" : v);
      await api.saveSettings({
        llm: {
          baseUrl: settings.llm.baseUrl, model: settings.llm.model, maxChars: settings.llm.maxChars,
          apiKey: "", temperature: settings.llm.temperature ?? 0.3, maxTokens: settings.llm.maxTokens || 4096,
        },
        botToken: "",
        prompts: {
          system: norm(system, settings.defaultPrompts.system),
          user: norm(user, settings.defaultPrompts.user),
          reduce: norm(reduce, settings.defaultPrompts.reduce),
        },
      });
      const fresh = await onReload();
      setSystem(fresh.prompts.system || fresh.defaultPrompts.system);
      setUser(fresh.prompts.user || fresh.defaultPrompts.user);
      setReduce(fresh.prompts.reduce || fresh.defaultPrompts.reduce);
      pushToast("提示詞已儲存", "ok");
    } catch (err) {
      pushToast(`儲存失敗：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setBusy("");
    }
  };

  const restore = () => {
    setSystem(settings.defaultPrompts.system);
    setUser(settings.defaultPrompts.user);
    setReduce(settings.defaultPrompts.reduce);
    pushToast("已還原預設提示詞（儲存後生效）", "info");
  };

  const textarea = `${inputCls} resize-y font-mono text-[12px] leading-relaxed`;

  return (
    <div className="space-y-4">
      <SectionLabel
        right={
          <span className="flex items-center gap-2">
            <Chip tone={settings.prompts.system || settings.prompts.user || settings.prompts.reduce ? "lime" : "dim"}>
              {settings.prompts.system || settings.prompts.user || settings.prompts.reduce ? "已自訂" : "內建"}
            </Chip>
          </span>
        }
      >
        PROMPTS / 摘要引擎的 Prompt
      </SectionLabel>

      <Notice tone="info" icon={<ScrollText size={12} />}>
        未自訂時使用預設提示詞。可用變數：
        {VARS.map((v) => (
          <button
            key={v}
            onClick={() => {
              const el = document.activeElement as HTMLTextAreaElement | null;
              if (el && el.tagName === "TEXTAREA") {
                const pos = el.selectionStart ?? el.value.length;
                const token = `{{${v}}}`;
                const next = el.value.slice(0, pos) + token + el.value.slice(pos);
                (which === "system" ? setSystem : which === "user" ? setUser : setReduce)(next);
              }
            }}
            className="mx-0.5 rounded border border-cyan/25 px-1 font-mono text-[10.5px] text-cyan transition hover:bg-cyan/10"
            title="插入到游標位置"
          >
            {`{{${v}}}`}
          </button>
        ))}
        <span className="ml-1 text-dim">（body 是訊息本體，partials 是合併階段）</span>
      </Notice>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel space-y-4 p-5">
          <Field label="System" hint={`${system.length} 字`}>
            <textarea className={textarea} rows={10} value={system} onChange={(e) => setSystem(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="使用者訊息模板" hint={`${user.length} 字`}>
            <textarea className={textarea} rows={8} value={user} onChange={(e) => setUser(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="合併階段（多批次時）" hint={`${reduce.length} 字`}>
            <textarea className={textarea} rows={5} value={reduce} onChange={(e) => setReduce(e.target.value)} spellCheck={false} />
          </Field>
          <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
            <AdminButton primary onClick={save} disabled={busy !== "" || !dirty}>
              {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              儲存提示詞
            </AdminButton>
            <AdminButton onClick={restore} disabled={busy !== ""}>
              <RotateCcw size={13} /> 載入內建
            </AdminButton>
          </div>
        </div>

        <div className="panel p-5">
          <div className="mb-3 flex items-center gap-1.5">
            {(["system", "user", "reduce"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setWhich(k)}
                className={`rounded-md border px-2 py-1 font-mono text-[10.5px] uppercase transition ${
                  which === k ? "border-lime/40 bg-lime/10 text-lime" : "border-white/[0.08] text-dim hover:text-fog"
                }`}
              >
                {k}
              </button>
            ))}
            <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-dim">
              <Wand2 size={10} /> 用假資料代入變數的預覽
            </span>
          </div>
          <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.06] bg-black/30 p-3 font-mono text-[11.5px] leading-relaxed text-fog">
            {preview || "（空）"}
          </pre>
        </div>
      </div>
    </div>
  );
}
