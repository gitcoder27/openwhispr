import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { isUsableSelfHostedUrl } from "../../helpers/meetingTranscriptionRouting";
import ApiKeyInput from "../ui/ApiKeyInput";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Check, Loader2, X } from "../icons";
import type { SelfHostedCheckError, SelfHostedStreamCheck } from "../../types/electron";

// Note Recording → Self-Hosted: meetings reuse the server (address and key)
// set up for dictation and send it pause-cut batch segments, so this panel
// edits those shared settings and tests the same connection.
export default function MeetingSelfHostedPanel() {
  const { t } = useTranslation();
  const url = useSettingsStore((s) => s.remoteTranscriptionUrl);
  const setUrl = useSettingsStore((s) => s.setRemoteTranscriptionUrl);
  const apiKey = useSettingsStore((s) => s.customTranscriptionApiKey);
  const setApiKey = useSettingsStore((s) => s.setCustomTranscriptionApiKey);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<SelfHostedStreamCheck | null>(null);

  // A result describes the address and key it was run against.
  useEffect(() => setCheck(null), [url, apiKey]);

  const trimmedUrl = url.trim();
  const urlProblem = !trimmedUrl
    ? t("settingsPage.transcription.meetingSelfHosted.urlMissing")
    : !isUsableSelfHostedUrl(trimmedUrl)
      ? t("settingsPage.transcription.meetingSelfHosted.urlInvalid")
      : null;

  const runCheck = async () => {
    if (!window.electronAPI?.checkSelfHostedStreaming) return;
    setChecking(true);
    try {
      setCheck(await window.electronAPI.checkSelfHostedStreaming(trimmedUrl));
    } catch {
      setCheck(null);
    } finally {
      setChecking(false);
    }
  };

  const errorText = (error: SelfHostedCheckError | null) =>
    t(`settingsPage.selfHosted.streaming.errors.${error ?? "unreachable"}`);

  return (
    <div className="border border-border rounded-lg p-3 space-y-2.5">
      <p className="text-xs text-muted-foreground">
        {t("settingsPage.transcription.meetingSelfHosted.shared")}
      </p>
      <div className="space-y-1.5">
        <label
          htmlFor="meeting-self-hosted-url"
          className="block text-xs font-medium text-foreground"
        >
          {t("settingsPage.selfHosted.serverUrl")}
        </label>
        <Input
          id="meeting-self-hosted-url"
          dir="ltr"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://stt.example.com"
          autoComplete="off"
          spellCheck={false}
        />
        {urlProblem && <p className="text-xs text-warning">{urlProblem}</p>}
      </div>

      <ApiKeyInput
        apiKey={apiKey}
        setApiKey={setApiKey}
        label={t("settingsPage.selfHosted.streaming.apiKey")}
        helpText={t("settingsPage.transcription.meetingSelfHosted.apiKeyHelp")}
      />

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={runCheck}
          disabled={checking || Boolean(urlProblem)}
        >
          {checking && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {t("settingsPage.selfHosted.streaming.test")}
        </Button>
        {check && (
          <span className="flex items-center gap-1.5 text-xs" aria-live="polite">
            {check.http.ok ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
            ) : (
              <X className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
            )}
            <span className="font-medium text-foreground">
              {t("settingsPage.selfHosted.streaming.checkHttp")}
            </span>
            <span className="text-muted-foreground">
              {check.http.ok
                ? t("settingsPage.selfHosted.streaming.ms", { ms: check.http.ms })
                : errorText(check.http.error)}
            </span>
          </span>
        )}
      </div>

      <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
        <li>{t("settingsPage.transcription.meetingSelfHosted.batchNote")}</li>
        <li>{t("settingsPage.transcription.meetingSelfHosted.languageNote")}</li>
      </ul>
    </div>
  );
}
