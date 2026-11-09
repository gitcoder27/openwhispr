// Note recording only offers providers the main process will actually run:
// meeting prepare/start check ALLOWED_MEETING_PROVIDERS (derived from the
// streaming client table in meetingStreamingProviders.js) and reject anything
// else with no user-visible message. Without this intersection, every registry
// model marked `streaming: true` reaches the notes picker — including
// dictation-only ones like Gemini Live — and fails silently there. The closure
// is pinned by test/helpers/meetingStreamingProviders.test.js.
export const MEETING_STREAMING_PROVIDER_IDS = [
  "openai",
  "assemblyai",
  "deepgram",
  "corti",
  "tinfoil",
];

export function filterMeetingStreamingProviders(providers) {
  return providers.filter((provider) => MEETING_STREAMING_PROVIDER_IDS.includes(provider.id));
}

const DEFAULT_MANAGED_PROVIDER = {
  id: "openai",
  models: [{ id: "gpt-4o-mini-transcribe", default: true }],
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The rules the main process enforces for a self-hosted server (orukeetStreaming
// streamingUrl): no credentials or query, and HTTPS unless the server runs on
// this machine. Checked here too so a bad address fails before recording starts.
export function isUsableSelfHostedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:" || url.protocol === "wss:") return true;
  return (url.protocol === "http:" || url.protocol === "ws:") && LOOPBACK_HOSTS.has(url.hostname);
}

const resolveModel = (provider, selectedModel) =>
  provider.models.find((model) => model.id === selectedModel)?.id ??
  provider.models.find((model) => model.default)?.id ??
  provider.models[0]?.id;

export function resolveMeetingTranscriptionOptions({
  transcriptionMode,
  language,
  localProvider,
  whisperModel,
  parakeetModel,
  cohereModel,
  selectedProvider,
  selectedModel,
  byokProviders,
  managedProviders,
  cortiEnvironment,
  cortiTenant,
  keyterms,
  remoteTranscriptionUrl,
  remoteTranscriptionModel,
}) {
  if (transcriptionMode === "local") {
    return {
      provider: "local",
      localProvider,
      localModel:
        localProvider === "nvidia"
          ? parakeetModel || "parakeet-tdt-0.6b-v3"
          : localProvider === "cohere"
            ? cohereModel || "cohere-transcribe-03-2026"
            : whisperModel || "base",
      language,
    };
  }

  if (transcriptionMode === "openwhispr") {
    const provider = managedProviders?.[0] ?? DEFAULT_MANAGED_PROVIDER;
    return {
      provider: `${provider.id}-realtime`,
      model: resolveModel(provider, selectedModel),
      mode: "openwhispr",
      language,
    };
  }

  // Errors here are sentinels that MeetingRecordingMount translates, not English
  // sentences (some are reachable from a settings copy the user never made by
  // hand — the 1.6.10 follow-flag migration). Anything after the colon is an
  // argument.
  //
  // Self-hosted meetings post pause-cut chunks to the server's batch endpoint
  // (selfHostedMeetingSession.js). The key stays in the main process.
  if (transcriptionMode === "self-hosted") {
    const baseUrl = typeof remoteTranscriptionUrl === "string" ? remoteTranscriptionUrl.trim() : "";
    if (!baseUrl) throw new Error("selfHostedUrlMissing");
    if (!isUsableSelfHostedUrl(baseUrl)) throw new Error("selfHostedUrlInvalid");
    const model =
      typeof remoteTranscriptionModel === "string" ? remoteTranscriptionModel.trim() : "";
    return {
      provider: "self-hosted",
      baseUrl,
      ...(model ? { model } : {}),
      language,
    };
  }

  if (transcriptionMode !== "providers") {
    throw new Error(`Unsupported Note Recording transcription mode: ${transcriptionMode}`);
  }

  const provider = byokProviders.find((candidate) => candidate.id === selectedProvider);
  if (!provider) {
    throw new Error(
      selectedProvider ? `unsupportedProvider:${selectedProvider}` : "noProviderSelected"
    );
  }

  const options = {
    provider: `${provider.id}-realtime`,
    model: resolveModel(provider, selectedModel),
    mode: "byok",
    language,
  };

  if (provider.id === "corti") {
    return {
      ...options,
      environment: cortiEnvironment,
      tenant: cortiTenant,
      keyterms,
    };
  }

  return options;
}
