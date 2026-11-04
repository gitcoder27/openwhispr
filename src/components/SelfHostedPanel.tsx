import { useTranslation } from "react-i18next";
import { ORUKEET_MODEL } from "../helpers/dictationStreamingRouting";
import { useConnectionAutoCheck } from "../hooks/useConnectionAutoCheck";
import { useFocusHold } from "../hooks/useFocusHold";
import { useTypingPause } from "../hooks/useTypingPause";
import { ConnectionCheckAnnouncer } from "./ui/ConnectionCheckAnnouncer";
import { ProviderCheckField } from "./ui/ProviderCheckField";
import { usePanelVisible } from "./ui/usePanelVisible";
import SelfHostedStreamingSettings from "./SelfHostedStreamingSettings";
import { useSettingsStore } from "../stores/settingsStore";

interface SelfHostedPanelProps {
  service: "transcription" | "reasoning";
  url: string;
  onUrlChange: (url: string) => void;
  model?: string;
  onModelChange?: (model: string) => void;
  /** Dictation only: the key, streaming switch and connection test. */
  streamingControls?: boolean;
}

export default function SelfHostedPanel({
  service,
  url,
  onUrlChange,
  model,
  onModelChange,
  streamingControls = false,
}: SelfHostedPanelProps) {
  const { t } = useTranslation();
  // A streaming server is asked with its key by Test connection; the model check is
  // key-less and checks a field streaming doesn't use.
  const streamingOn = useSettingsStore((s) => streamingControls && s.remoteTranscriptionStreaming);
  const urlHold = useFocusHold();
  const editing = useFocusHold();
  const visible = usePanelVisible();
  const trimmedModel = (model ?? "").trim();
  // The address and model save as they are typed.
  const delayMs = useTypingPause({
    typed: `${url}\n${model ?? ""}`,
    context: JSON.stringify([service, visible]),
    held: editing.held,
  });
  const check = useConnectionAutoCheck({
    config: { scope: service, provider: "custom", baseUrl: url, model },
    ready:
      Boolean(onModelChange && url.trim() && trimmedModel) &&
      // The app sends this model's server a key this panel has no field for, so a check
      // could only ask without it.
      trimmedModel !== ORUKEET_MODEL &&
      !streamingOn &&
      // A hidden panel is not ready to ask; a shown one asks again, and the main process
      // answers a check it remembers at once.
      visible,
    // A half-typed address may belong to someone else: nothing is sent while it is edited.
    hold: urlHold.held,
    delayMs,
  });

  const placeholderUrl =
    service === "transcription" ? "http://192.168.1.126:8178" : "http://192.168.1.126:8080";

  return (
    <div
      className="border border-border rounded-lg p-3 space-y-2.5"
      onFocus={editing.onFocus}
      onBlur={editing.onBlur}
    >
      <ConnectionCheckAnnouncer announcement={check.announcement} />
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-foreground">
          {t("settingsPage.selfHosted.serverUrl")}
        </label>
        <ProviderCheckField
          aria-label={t("settingsPage.selfHosted.serverUrl")}
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          onFocus={urlHold.onFocus}
          onBlur={urlHold.onBlur}
          placeholder={placeholderUrl}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {onModelChange && !streamingOn && (
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">{t("common.model")}</label>
          <ProviderCheckField
            aria-label={t("common.model")}
            check={check}
            invalidOn="modelNotFound"
            // This server is sent no key, so a refusal means it wants one.
            failureReason={
              check.failure?.errorCode === "credentialsRejected"
                ? t("reasoning.custom.endpointUnauthorized")
                : undefined
            }
            value={model ?? ""}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="Whisper-Large-v3-Turbo"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
      {streamingControls && <SelfHostedStreamingSettings url={url} />}
    </div>
  );
}
