const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/helpers/meetingTranscriptionRouting.js");
const modelRegistryData = require("../../src/models/modelRegistryData.json");

// Sentinels this module throws, paired with the MEETING_ERROR_KEYS entry that
// MeetingRecordingMount looks up. A healed legacy profile can reach any of them,
// so an untranslated one would show a bare sentinel in the failure toast.
const SENTINEL_KEYS = {
  selfHostedUrlMissing: "selfHostedUrlMissing",
  selfHostedUrlInvalid: "selfHostedUrlInvalid",
  unsupportedProvider: "unsupportedProvider",
  noProviderSelected: "noProviderSelected",
};

const byokProviders = [
  {
    id: "openai",
    models: [{ id: "gpt-4o-mini-transcribe" }, { id: "gpt-4o-transcribe" }],
  },
  { id: "corti", models: [{ id: "corti-transcribe" }] },
  { id: "tinfoil", models: [{ id: "voxtral-mini-4b-realtime" }] },
  { id: "deepgram", models: [{ id: "nova-3", default: true }] },
  {
    id: "assemblyai",
    models: [{ id: "universal-streaming-english", default: true }],
  },
];

const baseOptions = {
  transcriptionMode: "providers",
  language: "en",
  localProvider: "whisper",
  whisperModel: "small",
  parakeetModel: "parakeet-tdt-0.6b-v3",
  selectedProvider: "tinfoil",
  selectedModel: "voxtral-mini-4b-realtime",
  byokProviders,
  managedProviders: [
    {
      id: "assemblyai",
      models: [{ id: "universal-streaming", default: true }],
    },
  ],
  cortiEnvironment: "us",
  cortiTenant: "tenant",
  keyterms: ["OpenWhispr"],
};

test("providers mode routes Tinfoil through its realtime client", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(resolveMeetingTranscriptionOptions(baseOptions), {
    provider: "tinfoil-realtime",
    model: "voxtral-mini-4b-realtime",
    mode: "byok",
    language: "en",
  });
});

test("BYOK Deepgram and AssemblyAI route to their own realtime clients", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  for (const [selectedProvider, model] of [
    ["deepgram", "nova-3"],
    ["assemblyai", "universal-streaming-english"],
  ]) {
    assert.deepEqual(
      resolveMeetingTranscriptionOptions({ ...baseOptions, selectedProvider, selectedModel: "" }),
      { provider: `${selectedProvider}-realtime`, model, mode: "byok", language: "en" }
    );
  }
});

test("BYOK OpenAI never downgrades to managed cloud when its key is unavailable", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      selectedProvider: "openai",
      selectedModel: "gpt-4o-mini-transcribe",
    }),
    {
      provider: "openai-realtime",
      model: "gpt-4o-mini-transcribe",
      mode: "byok",
      language: "en",
    }
  );
});

test("self-hosted mode routes to the server's batch path, never a stale Tinfoil provider", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "  https://stt.example.com/v1  ",
      remoteTranscriptionModel: "parakeet-tdt-0.6b-v3",
    }),
    {
      provider: "self-hosted",
      baseUrl: "https://stt.example.com/v1",
      model: "parakeet-tdt-0.6b-v3",
      language: "en",
    }
  );
});

test("self-hosted options never carry a key and omit an empty model", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  const options = resolveMeetingTranscriptionOptions({
    ...baseOptions,
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "http://127.0.0.1:8770",
    remoteTranscriptionModel: " ",
  });
  assert.deepEqual(options, {
    provider: "self-hosted",
    baseUrl: "http://127.0.0.1:8770",
    language: "en",
  });
  assert.equal(JSON.stringify(options).toLowerCase().includes("key"), false);
});

test("self-hosted mode without a usable URL fails with a sentinel", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  for (const [remoteTranscriptionUrl, message] of [
    [undefined, "selfHostedUrlMissing"],
    ["   ", "selfHostedUrlMissing"],
    ["not a url", "selfHostedUrlInvalid"],
    // Plain HTTP only reaches this machine; anything else needs HTTPS.
    ["http://192.168.1.20:8770", "selfHostedUrlInvalid"],
    ["https://user:pass@stt.example.com", "selfHostedUrlInvalid"],
    ["https://stt.example.com/?key=abc", "selfHostedUrlInvalid"],
    ["ftp://stt.example.com", "selfHostedUrlInvalid"],
  ]) {
    assert.throws(
      () =>
        resolveMeetingTranscriptionOptions({
          ...baseOptions,
          transcriptionMode: "self-hosted",
          remoteTranscriptionUrl,
        }),
      { message },
      JSON.stringify(remoteTranscriptionUrl)
    );
  }
});

test("self-hosted URL rules match the main process's streamingUrl", async () => {
  const { isUsableSelfHostedUrl } = await load();
  const { streamingUrl } = require("../../src/helpers/orukeetStreaming");

  for (const url of [
    "https://stt.example.com",
    "https://stt.example.com/v1/audio/transcriptions",
    "wss://stt.example.com",
    "http://localhost:8770",
    "http://127.0.0.1:8770/",
    "http://[::1]:8770",
    "http://10.0.0.5:8770",
    "https://a:b@stt.example.com",
    "https://stt.example.com/#x",
  ]) {
    let accepted = true;
    try {
      streamingUrl(url);
    } catch {
      accepted = false;
    }
    assert.equal(isUsableSelfHostedUrl(url), accepted, url);
  }
});

test("local mode wins over stale cloud provider state", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      transcriptionMode: "local",
      localProvider: "nvidia",
      parakeetModel: "nemotron-speech-streaming-en-0.6b",
    }),
    {
      provider: "local",
      localProvider: "nvidia",
      localModel: "nemotron-speech-streaming-en-0.6b",
      language: "en",
    }
  );
});

test("managed mode ignores stale BYOK state", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      transcriptionMode: "openwhispr",
    }),
    {
      provider: "assemblyai-realtime",
      model: "universal-streaming",
      mode: "openwhispr",
      language: "en",
    }
  );
});

test("managed mode keeps its established OpenAI default before the catalog loads", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      transcriptionMode: "openwhispr",
      managedProviders: null,
    }),
    {
      provider: "openai-realtime",
      model: "gpt-4o-mini-transcribe",
      mode: "openwhispr",
      language: "en",
    }
  );
});

test("Corti keeps the meeting-specific connection settings", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      selectedProvider: "corti",
      selectedModel: "corti-transcribe",
    }),
    {
      provider: "corti-realtime",
      model: "corti-transcribe",
      mode: "byok",
      language: "en",
      environment: "us",
      tenant: "tenant",
      keyterms: ["OpenWhispr"],
    }
  );
});

test("unknown and custom providers fail closed", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  // Sentinels, translated at display time by MeetingRecordingMount. The named
  // provider rides after the colon so the toast can say which one failed.
  for (const [selectedProvider, message] of [
    ["custom", "unsupportedProvider:custom"],
    ["groq", "unsupportedProvider:groq"],
    ["", "noProviderSelected"],
    [undefined, "noProviderSelected"],
  ]) {
    assert.throws(
      () =>
        resolveMeetingTranscriptionOptions({
          ...baseOptions,
          selectedProvider,
        }),
      { message },
      `provider ${JSON.stringify(selectedProvider)}`
    );
  }
});

test("every thrown sentinel is translated and rendered by the mount", () => {
  const translation = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  const mount = fs.readFileSync(
    path.join(__dirname, "../../src/components/MeetingRecordingMount.tsx"),
    "utf8"
  );

  for (const [sentinel, key] of Object.entries(SENTINEL_KEYS)) {
    assert.equal(
      typeof translation.notes.meeting[key],
      "string",
      `notes.meeting.${key} missing from en/translation.json`
    );
    assert.ok(
      mount.includes(`${sentinel}: "notes.meeting.${key}"`),
      `MEETING_ERROR_KEYS is missing ${sentinel}`
    );
  }

  // The provider sentinel carries its argument after a colon, so its copy has to
  // have somewhere to put it.
  assert.match(translation.notes.meeting.unsupportedProvider, /\{\{provider\}\}/);
});

// gpt-live-transcribe has no server VAD and only completes a turn when the client
// commits, which dictation does on stop and a long-running meeting stream never
// does. Until that guard exists, the desktop must not be able to route a meeting
// onto it: no registry entry, and a stale selection falls back to the default.
test("gpt-live-transcribe is never offered for Note Recording", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();
  // Mirrors getStreamingTranscriptionProviders(): the meeting BYOK picker.
  const registryStreamingProviders = modelRegistryData.transcriptionProviders
    .map((provider) => ({ ...provider, models: provider.models.filter((m) => m.streaming) }))
    .filter((provider) => provider.models.length > 0);
  for (const provider of registryStreamingProviders) {
    for (const model of provider.models) {
      assert.equal(model.id.startsWith("gpt-live-transcribe"), false, model.id);
    }
  }

  assert.equal(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      selectedProvider: "openai",
      selectedModel: "gpt-live-transcribe",
      byokProviders: registryStreamingProviders,
    }).model,
    "gpt-4o-mini-transcribe"
  );
  const managedCatalogs = [
    null,
    [{ id: "openai", models: [{ id: "gpt-4o-mini-transcribe", default: true }] }],
  ];
  for (const managedProviders of managedCatalogs) {
    assert.equal(
      resolveMeetingTranscriptionOptions({
        ...baseOptions,
        transcriptionMode: "openwhispr",
        managedProviders,
        selectedModel: "gpt-live-transcribe",
      }).model,
      "gpt-4o-mini-transcribe"
    );
  }
});
