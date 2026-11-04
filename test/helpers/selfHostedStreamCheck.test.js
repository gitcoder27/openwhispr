const test = require("node:test");
const assert = require("node:assert/strict");
const {
  checkSelfHostedStreaming,
  classifyStreamError,
  modelsUrl,
} = require("../../src/helpers/selfHostedStreamCheck");

const fakeStreaming = (connect) => () => ({ connect, disconnect: async () => ({}) });
const okFetch = async () => ({ ok: true, status: 200 });

test("modelsUrl points at the server's /v1/models whatever form the address takes", () => {
  assert.equal(modelsUrl("https://stt.example.com/v1"), "https://stt.example.com/v1/models");
  assert.equal(modelsUrl("https://stt.example.com"), "https://stt.example.com/v1/models");
  assert.equal(modelsUrl("http://localhost:8770/v1/"), "http://localhost:8770/v1/models");
});

test("a reachable streaming server passes both checks with the key", async () => {
  let sentKey = null;
  let headers = null;
  const result = await checkSelfHostedStreaming({
    baseUrl: " https://stt.example.com/v1 ",
    apiKey: "secret",
    fetchImpl: async (_url, init) => {
      headers = init.headers;
      return { ok: true, status: 200 };
    },
    createStreaming: fakeStreaming(async ({ apiKey }) => {
      sentKey = apiKey;
    }),
  });
  assert.equal(result.http.ok, true);
  assert.equal(result.stream.ok, true);
  assert.equal(sentKey, "secret");
  assert.deepEqual(headers, { Authorization: "Bearer secret" });
});

test("a rejected key is reported as unauthorized on both checks", async () => {
  const result = await checkSelfHostedStreaming({
    baseUrl: "https://stt.example.com/v1",
    apiKey: "wrong",
    fetchImpl: async () => ({ ok: false, status: 401 }),
    createStreaming: fakeStreaming(async () => {
      throw new Error("Unexpected server response: 403");
    }),
  });
  assert.equal(result.http.error, "unauthorized");
  assert.equal(result.stream.error, "unauthorized");
});

test("streaming without a key is not attempted", async () => {
  let attempted = false;
  const result = await checkSelfHostedStreaming({
    baseUrl: "https://stt.example.com/v1",
    apiKey: "",
    fetchImpl: okFetch,
    createStreaming: fakeStreaming(async () => {
      attempted = true;
    }),
  });
  assert.equal(result.stream.error, "key_missing");
  assert.equal(attempted, false);
});

test("a plain-http remote address is refused before anything is sent", async () => {
  let fetched = false;
  const result = await checkSelfHostedStreaming({
    baseUrl: "http://stt.example.com/v1",
    apiKey: "secret",
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, status: 200 };
    },
    createStreaming: fakeStreaming(async () => {}),
  });
  assert.equal(result.stream.error, "invalid_url");
  assert.equal(result.http.error, "invalid_url");
  assert.equal(fetched, false);
});

test("stream errors map to the codes the panel words", () => {
  assert.equal(classifyStreamError(new Error("Orukeet connection timed out")), "timeout");
  assert.equal(
    classifyStreamError(new Error("Orukeet server does not support mono 16 kHz PCM")),
    "not_supported"
  );
  assert.equal(classifyStreamError(new Error("Unexpected server response: 404")), "not_supported");
  assert.equal(
    classifyStreamError(new Error("getaddrinfo ENOTFOUND stt.example.com")),
    "unreachable"
  );
});
