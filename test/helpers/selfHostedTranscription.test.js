const test = require("node:test");
const assert = require("node:assert/strict");

test("isSelfHostedTranscription returns true for self-hosted mode with configured URL", async () => {
  const { isSelfHostedTranscription } = await import("../../src/helpers/selfHostedTranscription.js");
  assert.equal(
    isSelfHostedTranscription({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
    }),
    true
  );
});

test("isSelfHostedTranscription returns false for providers mode even with configured URL", async () => {
  const { isSelfHostedTranscription } = await import("../../src/helpers/selfHostedTranscription.js");
  assert.equal(
    isSelfHostedTranscription({
      transcriptionMode: "providers",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
    }),
    false
  );
});

test("isSelfHostedTranscription returns false for empty URL", async () => {
  const { isSelfHostedTranscription } = await import("../../src/helpers/selfHostedTranscription.js");
  assert.equal(
    isSelfHostedTranscription({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "",
    }),
    false
  );
});

test("isSelfHostedTranscription returns false for whitespace-only URL", async () => {
  const { isSelfHostedTranscription } = await import("../../src/helpers/selfHostedTranscription.js");
  assert.equal(
    isSelfHostedTranscription({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "   ",
    }),
    false
  );
});

test("isSelfHostedTranscription returns false for empty settings object", async () => {
  const { isSelfHostedTranscription } = await import("../../src/helpers/selfHostedTranscription.js");
  assert.equal(isSelfHostedTranscription({}), false);
});

test("resolveSelfHostedTranscriptionModel returns the trimmed model", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
      remoteTranscriptionModel: "  custom-whisper  ",
    }),
    "custom-whisper"
  );
});

test("resolveSelfHostedTranscriptionModel returns null for empty model", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
      remoteTranscriptionModel: "",
    }),
    null
  );
});

test("resolveSelfHostedTranscriptionModel returns null for whitespace-only model", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
      remoteTranscriptionModel: "   ",
    }),
    null
  );
});

test("resolveSelfHostedTranscriptionModel returns null when mode is not self-hosted", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "providers",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
      remoteTranscriptionModel: "custom-whisper",
    }),
    null
  );
});

test("resolveSelfHostedTranscriptionModel returns null when URL is empty", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "",
      remoteTranscriptionModel: "custom-whisper",
    }),
    null
  );
});

test("resolveSelfHostedTranscriptionModel returns null when remoteTranscriptionModel is not a string", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
      remoteTranscriptionModel: 42,
    }),
    null
  );
});

const selfHosted = {
  transcriptionMode: "self-hosted",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: "openai",
  remoteTranscriptionUrl: "https://stt.example.com/v1",
  remoteTranscriptionModel: "whisper-large-v3",
};

test("self-hosted streaming needs the switch, not the Orukeet model id", async () => {
  const { isOrukeetStreaming, isSelfHostedStreaming } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(isSelfHostedStreaming(selfHosted), false);
  assert.equal(isOrukeetStreaming(selfHosted), false);
  const on = { ...selfHosted, remoteTranscriptionStreaming: true };
  assert.equal(isSelfHostedStreaming(on), true);
  assert.equal(isOrukeetStreaming(on), true);
});

test("the streaming switch does nothing outside self-hosted mode or without a URL", async () => {
  const { isOrukeetStreaming } = await import("../../src/helpers/selfHostedTranscription.js");
  const on = { ...selfHosted, remoteTranscriptionStreaming: true };
  assert.equal(isOrukeetStreaming({ ...on, transcriptionMode: "providers" }), false);
  assert.equal(isOrukeetStreaming({ ...on, remoteTranscriptionUrl: " " }), false);
});

test("the custom provider with the Orukeet model id still streams", async () => {
  const { isOrukeetStreaming } = await import("../../src/helpers/selfHostedTranscription.js");
  assert.equal(
    isOrukeetStreaming({
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionModel: "orukeet-v0.1.0",
      cloudTranscriptionBaseUrl: "https://stt.example.com/v1",
    }),
    true
  );
});

test("a self-hosted server gets the custom key only once streaming is switched on", async () => {
  const { selfHostedSendsApiKey } = await import("../../src/helpers/selfHostedTranscription.js");
  const { shouldSkipTranscriptionApiKey } = await import("../../src/helpers/transcriptionAuth.js");
  // A leftover key alone never reaches a batch server.
  const keyed = { ...selfHosted, customTranscriptionApiKey: "leftover" };
  assert.equal(selfHostedSendsApiKey(keyed), false);
  assert.equal(shouldSkipTranscriptionApiKey(keyed), true);
  const streaming = { ...keyed, remoteTranscriptionStreaming: true };
  assert.equal(selfHostedSendsApiKey(streaming), true);
  assert.equal(shouldSkipTranscriptionApiKey(streaming), false);
  assert.equal(selfHostedSendsApiKey({ ...streaming, transcriptionMode: "providers" }), false);
});

test("a self-hosted stream connects to the user's server even with a stale cloud mode", async () => {
  const { buildStreamingSessionOptions, resolveStreamingProviderName } = await import(
    "../../src/helpers/dictationStreamingRouting.js"
  );
  const settings = {
    ...selfHosted,
    cloudTranscriptionMode: "openwhispr",
    remoteTranscriptionStreaming: true,
  };
  const providerName = resolveStreamingProviderName({ settings, context: "dictation" });
  assert.equal(providerName, "orukeet");
  const options = buildStreamingSessionOptions({ providerName, settings });
  assert.equal(options.mode, "byok");
  assert.equal(options.baseUrl, "https://stt.example.com/v1");
  assert.equal(options.model, "orukeet-v0.1.0");
});
