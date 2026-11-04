import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../stores/settingsStore";
import ApiKeyInput from "./ui/ApiKeyInput";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle";
import { Check, Loader2, X } from "./icons";
import type {
  SelfHostedCheckError,
  SelfHostedStreamCheck,
  SelfHostedStreamStatus,
} from "../types/electron";

// The dictation Self-hosted panel's streaming controls: the "stream while you
// speak" switch, the server's key (sent only while streaming is on), a
// connection test, and how the last streamed dictation went. Uploads and reasoning never stream, so they don't
// render this.
export default function SelfHostedStreamingSettings({ url }: { url: string }) {
  const { t } = useTranslation();
  const streaming = useSettingsStore((s) => s.remoteTranscriptionStreaming);
  const setStreaming = useSettingsStore((s) => s.setRemoteTranscriptionStreaming);
  const apiKey = useSettingsStore((s) => s.customTranscriptionApiKey);
  const setApiKey = useSettingsStore((s) => s.setCustomTranscriptionApiKey);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<SelfHostedStreamCheck | null>(null);
  const [status, setStatus] = useState<SelfHostedStreamStatus | null>(null);

  const refreshStatus = useCallback(() => {
    window.electronAPI
      ?.getSelfHostedStreamStatus?.()
      .then((next) => setStatus(next ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
    window.addEventListener("focus", refreshStatus);
    return () => window.removeEventListener("focus", refreshStatus);
  }, [refreshStatus]);

  // A result describes the address and key it was run against.
  useEffect(() => setCheck(null), [url, apiKey]);

  const runCheck = async () => {
    if (!window.electronAPI?.checkSelfHostedStreaming) return;
    setChecking(true);
    try {
      setCheck(await window.electronAPI.checkSelfHostedStreaming(url));
    } catch {
      setCheck(null);
    } finally {
      setChecking(false);
    }
  };

  const errorText = (error: SelfHostedCheckError | null) =>
    t(`settingsPage.selfHosted.streaming.errors.${error ?? "unreachable"}`);
  const missingKey = streaming && !apiKey.trim();

  return (
    <div className="space-y-2.5 border-t border-border/70 pt-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">
            {t("settingsPage.selfHosted.streaming.toggle")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("settingsPage.selfHosted.streaming.toggleDescription")}
          </p>
        </div>
        <Toggle
          checked={streaming}
          onChange={setStreaming}
          ariaLabel={t("settingsPage.selfHosted.streaming.toggle")}
        />
      </div>

      {streaming && (
        <ApiKeyInput
          apiKey={apiKey}
          setApiKey={setApiKey}
          label={t("settingsPage.selfHosted.streaming.apiKey")}
          helpText={t("settingsPage.selfHosted.streaming.apiKeyHelp")}
        />
      )}

      {missingKey && (
        <p className="text-xs text-warning">{t("settingsPage.selfHosted.streaming.keyRequired")}</p>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={runCheck}
          disabled={checking || !url.trim()}
        >
          {checking && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {t("settingsPage.selfHosted.streaming.test")}
        </Button>
      </div>

      {check && (
        <ul className="space-y-1 text-xs" aria-live="polite">
          <CheckLine
            ok={check.http.ok}
            label={t("settingsPage.selfHosted.streaming.checkHttp")}
            detail={
              check.http.ok
                ? t("settingsPage.selfHosted.streaming.ms", { ms: check.http.ms })
                : errorText(check.http.error)
            }
          />
          <CheckLine
            ok={check.stream.ok}
            label={t("settingsPage.selfHosted.streaming.checkStream")}
            detail={
              check.stream.ok
                ? t("settingsPage.selfHosted.streaming.ms", { ms: check.stream.ms })
                : errorText(check.stream.error)
            }
          />
        </ul>
      )}

      {streaming && status && (
        <p className="text-xs text-muted-foreground">
          {status.outcome === "streamed"
            ? t("settingsPage.selfHosted.streaming.lastStreamed", {
                time: new Date(status.at).toLocaleTimeString(),
                seconds: (status.audioSeconds ?? 0).toFixed(1),
                finalSeconds: ((status.finalMs ?? 0) / 1000).toFixed(1),
              })
            : t("settingsPage.selfHosted.streaming.lastFailed", {
                time: new Date(status.at).toLocaleTimeString(),
                error: status.error ?? "",
              })}
        </p>
      )}
    </div>
  );
}

function CheckLine({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  const Icon = ok ? Check : X;
  return (
    <li className="flex items-center gap-1.5">
      <Icon
        className={`h-3.5 w-3.5 shrink-0 ${ok ? "text-success" : "text-destructive"}`}
        aria-hidden="true"
      />
      <span className="font-medium text-foreground">{label}</span>
      <span className="text-muted-foreground">{detail}</span>
    </li>
  );
}
