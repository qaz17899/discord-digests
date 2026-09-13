import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Zap, Loader2, Cable, KeyRound, Trash2, Check } from "lucide-react";
import { api, type ApiSettings, type ProbeResult } from "@/lib/api";
import { Chip, SectionLabel } from "../ui";
import { AdminButton, Field, KeyRow, Notice, Slider, inputCls } from "./widgets";

const MODEL_PRESETS = [
  "gpt-4o-mini", "gpt-4o", "claude-sonnet-4", "gemini-2.5-flash",
  "deepseek-chat", "qwen-max", "local/llama-3.1-70b",
];

interface Props {
  settings: ApiSettings;
  onReload: () => Promise<ApiSettings>;
  pushToast: (msg: string, kind?: "ok" | "info" | "danger") => void;
}

export function ProviderSection({ settings, onReload, pushToast }: Props) {
  const [baseUrl, setBaseUrl] = useState(settings.llm.baseUrl);
  const [model, setModel] = useState(settings.llm.model);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [temperature, setTemperature] = useState(settings.llm.temperature ?? 0.3);
  const [maxTokens, setMaxTokens] = useState(settings.llm.maxTokens || 4096);
  const [maxChars, setMaxChars] = useState(settings.llm.maxChars);
  const [botToken, setBotToken] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "llm" | "bot">("");
  const [probe, setProbe] = useState<{ llm?: ProbeResult; bot?: ProbeResult }>({});
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const dirty =
    baseUrl !== settings.llm.baseUrl ||
    model !== settings.llm.model ||
    maxChars !== settings.llm.maxChars ||
    temperature !== (settings.llm.temperature ?? 0.3) ||
    maxTokens !== (settings.llm.maxTokens || 4096) ||
    apiKey !== "" ||
    botToken !== "";

  const patch = () => ({
    llm: { baseUrl, model, maxChars, apiKey, temperature, maxTokens },
    botToken,
  });

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy("save");
    try {
      await api.saveSettings({ ...patch(), ...extra });
      await onReload();
      setApiKey("");
      setBotToken("");
      pushToast("已寫入 config.json", "ok");
    } catch (err) {
      pushToast(`儲存失敗：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setBusy("");
    }
  };

  /** Test the values currently typed, not the ones on disk. */
  const testLLM = async () => {
    setBusy("llm");
    setProbe((p) => ({ ...p, llm: undefined }));
    try {
      // Save first so the probe uses exactly what will be stored.
      await api.saveSettings(patch());
      const res = await api.testSettings({ what: "llm" });
      const r = res.llm ?? { ok: false, detail: "沒有回應" };
      setProbe((p) => ({ ...p, llm: r }));
      if (r.ok) {
        await onReload();
        setApiKey("");
        pushToast("連線成功", "ok");
      } else {
        pushToast(r.detail, "danger");
      }
    } catch (err) {
      pushToast(`測試失敗：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setBusy("");
    }
  };

  const testBot = async () => {
    setBusy("bot");
    try {
      if (botToken.trim()) {
        await api.saveSettings({ ...patch(), botToken });
        await onReload();
        setBotToken("");
      }
      const res = await api.testSettings({ what: "bot" });
      const r = res.bot ?? { ok: false, detail: "沒有回應" };
      setProbe((p) => ({ ...p, bot: r }));
      pushToast(r.ok ? "token 有效" : r.detail, r.ok ? "ok" : "danger");
    } catch (err) {
      pushToast(`測試失敗：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setBusy("");
    }
  };

  const clearSecret = async (which: "apiKey" | "botToken") => {
    setBusy("save");
    try {
      await api.saveSettings({
        llm: { baseUrl, model, maxChars, apiKey: "", temperature, maxTokens },
        botToken: "",
        ...(which === "apiKey" ? { clearApiKey: true } : { clearBotToken: true }),
      });
      await onReload();
      pushToast(which === "apiKey" ? "已清除 API key" : "已清除 bot token", "ok");
    } catch (err) {
      pushToast(`清除失敗：${err instanceof Error ? err.message : err}`, "danger");
    } finally {
      setBusy("");
    }
  };

  const host = (() => {
    try { return new URL(baseUrl).host; } catch { return baseUrl || "未設定"; }
  })();

  return (
    <div className="space-y-4">
      <SectionLabel
        right={
          settings.llm.apiKeySet ? (
            <Chip tone="lime"><Check size={10} /> key {settings.llm.apiKeyTag}</Chip>
          ) : (
            <Chip tone="amber">未設定</Chip>
          )
        }
      >
        PROVIDER / 模型供應商
      </SectionLabel>

      <div className="panel space-y-4 p-5">
        <div className="flex items-center gap-2">
          <Cable size={14} className="text-lime" />
          <span className="text-[13px] font-bold text-snow">{host}</span>
          {settings.llm.model && <span className="font-mono text-[11px] text-dim">{settings.llm.model}</span>}
        </div>

        <Field label="Base URL" hint="OpenAI 相容的 /chat/completions">
          <input
            className={`${inputCls} font-mono`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
          />
        </Field>

        <Field label="API key" hint={settings.llm.apiKeyEnv ? "來自 .env" : settings.llm.apiKeySet ? `已設定 ${settings.llm.apiKeyTag}，留空不變` : "還沒有 key"}>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              className={`${inputCls} pr-10 font-mono`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings.llm.apiKeySet ? "••••••••（留空＝不變）" : "sk-..."}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-dim transition hover:text-snow"
              title={showKey ? "隱藏" : "顯示"}
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>

        <Field label="模型" hint="可直接輸入">
          <input
            className={`${inputCls} font-mono`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            spellCheck={false}
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {MODEL_PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setModel(m)}
                className={`rounded-md border px-2 py-1 font-mono text-[10.5px] transition ${
                  model === m ? "border-lime/40 bg-lime/10 text-lime" : "border-white/[0.08] text-dim hover:border-white/20 hover:text-fog"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Slider label="Temperature" value={temperature} min={0} max={1.5} step={0.05}
            onChange={setTemperature} format={(v) => v.toFixed(2)} />
          <Slider label="Max tokens" value={maxTokens} min={512} max={32000} step={512}
            onChange={setMaxTokens} format={(v) => v.toLocaleString("en-US")} />
        </div>
        <Slider label="每批字元數" value={maxChars} min={20000} max={400000} step={10000}
          onChange={setMaxChars} format={(v) => v.toLocaleString("en-US")} />

        <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
          <AdminButton primary onClick={testLLM} disabled={busy !== ""}>
            {busy === "llm" ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
            測試連線並儲存
          </AdminButton>
          <AdminButton onClick={() => save()} disabled={busy !== "" || !dirty}>
            {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            只儲存
          </AdminButton>
        </div>
        {probe.llm && <Notice tone={probe.llm.ok ? "ok" : "warn"}>{probe.llm.detail}</Notice>}
        {settings.llm.apiKeyEnv && (
          <Notice tone="info">
            目前 key 來自 <span className="font-mono">.env</span> 的{' '}
            <span className="font-mono">DM_LLM_API_KEY</span>；這裡填的值會被它蓋過。
          </Notice>
        )}
        <Notice tone="info">
          金鑰僅保存於後端 <span className="font-mono">.env</span>，前端僅顯示末四碼；點擊「測試連線」將實際發送請求至模型端點進行驗證。
        </Notice>
      </div>

      <SectionLabel>ATTACHMENTS / 媒體連結更新</SectionLabel>
      <div className="panel space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-bold text-snow">Discord bot token</span>
          {settings.botTokenSet
            ? <Chip tone="lime"><Check size={10} /> {settings.botTokenTag}</Chip>
            : <Chip tone="amber">未設定</Chip>}
        </div>
        <p className="text-[11.5px] leading-relaxed text-dim">
          Discord 的附件網址約 24 小時後失效，此 Token 僅用於取得新簽名連結，Bot 本身無需加入任何伺服器。
        </p>
        {settings.botTokenEnv && (
          <Notice tone="info">
            目前 token 來自 <span className="font-mono">.env</span> 的{' '}
            <span className="font-mono">DISCORD_BOT_TOKEN</span>；這裡填的值會被它蓋過。
          </Notice>
        )}
        <Field label="Bot token" hint={settings.botTokenSet ? `已設定 ${settings.botTokenTag}，留空不變` : undefined}>
          <input
            type="password"
            className={`${inputCls} font-mono`}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={settings.botTokenSet ? "••••••••（留空＝不變）" : "MTA..."}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <AdminButton primary onClick={testBot} disabled={busy !== ""}>
            {busy === "bot" ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
            測試並儲存
          </AdminButton>
          {settings.botTokenSet && (
            <AdminButton danger onClick={() => clearSecret("botToken")} disabled={busy !== ""}>
              <Trash2 size={13} /> 清除 token
            </AdminButton>
          )}
        </div>
        {probe.bot && <Notice tone={probe.bot.ok ? "ok" : "warn"}>{probe.bot.detail}</Notice>}
      </div>

      <SectionLabel>LOCAL / 本機環境</SectionLabel>
      <div className="panel space-y-2.5 p-5">
        <KeyRow label="資料根目錄"><span className="font-mono">{settings.home}</span></KeyRow>
        <KeyRow label="讀取用 User Token">{settings.userTokenSet ? "已設定（.env 或環境變數）" : "未設定"}</KeyRow>
        <KeyRow label="設定檔寫入範圍">僅變更 config.json（模型、提示詞、Bot Token、監控清單、排程）；.env 需手動維護</KeyRow>
      </div>
    </div>
  );
}
