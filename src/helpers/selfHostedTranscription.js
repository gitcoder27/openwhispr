export function isSelfHostedTranscription(settings) {
  const mode =
    typeof settings?.transcriptionMode === "string" ? settings.transcriptionMode.trim() : "";
  const remoteUrl =
    typeof settings?.remoteTranscriptionUrl === "string"
      ? settings.remoteTranscriptionUrl.trim()
      : "";
  return mode === "self-hosted" && remoteUrl.length > 0;
}

export function resolveSelfHostedTranscriptionModel(settings) {
  if (!isSelfHostedTranscription(settings)) return null;
  const model =
    typeof settings?.remoteTranscriptionModel === "string"
      ? settings.remoteTranscriptionModel.trim()
      : "";
  return model.length > 0 ? model : null;
}

// The explicit model id opts compatible custom endpoints into Orukeet's PCM
// protocol. Other self-hosted models retain their existing HTTP route.
export function isOrukeetEndpoint(settings) {
  return (
    settings?.cloudTranscriptionProvider === "custom" &&
    (settings?.remoteTranscriptionModel || settings?.cloudTranscriptionModel) ===
      "orukeet-v0.1.0" &&
    Boolean(settings?.remoteTranscriptionUrl || settings?.cloudTranscriptionBaseUrl)
  );
}

// The Self-hosted panel's "Stream while you speak" switch: the server speaks
// Orukeet's PCM protocol, whatever model id is typed for its batch endpoint.
export function isSelfHostedStreaming(settings) {
  return isSelfHostedTranscription(settings) && settings?.remoteTranscriptionStreaming === true;
}

// A batch self-hosted server stays key-less: the custom key slot may hold a
// leftover from an abandoned Custom setup. Only a server the user switched to
// streaming, where the panel shows that key, is sent it.
export function selfHostedSendsApiKey(settings) {
  return isOrukeetEndpoint(settings) || isSelfHostedStreaming(settings);
}

export function isOrukeetStreaming(settings) {
  if (isSelfHostedStreaming(settings)) return true;
  return settings?.cloudTranscriptionMode === "byok" && isOrukeetEndpoint(settings);
}
