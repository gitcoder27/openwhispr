const { OrukeetStreaming, streamingUrl } = require("./orukeetStreaming");

// Settings → Self-hosted → Test connection: asks the server the same two
// questions a dictation would, and how long each took. Main process only, so
// the key never reaches the renderer.
const CHECK_TIMEOUT_MS = 8000;

function modelsUrl(baseUrl) {
  const url = new URL(streamingUrl(baseUrl));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/audio\/transcriptions\/stream$/, "/models");
  return url.toString();
}

// Error codes the panel words; anything unrecognised reads as unreachable.
function classifyStreamError(error) {
  const message = String(error?.message || "");
  if (/\b(401|403)\b/.test(message)) return "unauthorized";
  if (/timed out/i.test(message)) return "timeout";
  if (/HTTPS|credentials or query|Invalid URL/i.test(message)) return "invalid_url";
  if (/does not support|ready message|Unexpected server response: 404/i.test(message)) {
    return "not_supported";
  }
  return "unreachable";
}

async function checkHttp({ baseUrl, apiKey, fetchImpl, now }) {
  const started = now();
  try {
    const response = await fetchImpl(modelsUrl(baseUrl), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const ms = Math.round(now() - started);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, ms, status: response.status, error: "unauthorized" };
    }
    return {
      ok: response.ok,
      ms,
      status: response.status,
      error: response.ok ? null : "http_error",
    };
  } catch (error) {
    const ms = Math.round(now() - started);
    return { ok: false, ms, status: null, error: classifyStreamError(error) };
  }
}

async function checkStream({ baseUrl, apiKey, createStreaming, now }) {
  if (!apiKey) return { ok: false, ms: null, error: "key_missing" };
  const started = now();
  const streaming = createStreaming();
  try {
    await streaming.connect({ apiKey, baseUrl });
    return { ok: true, ms: Math.round(now() - started), error: null };
  } catch (error) {
    return { ok: false, ms: Math.round(now() - started), error: classifyStreamError(error) };
  } finally {
    // No audio was sent, so this closes without a commit.
    await streaming.disconnect().catch(() => {});
  }
}

async function checkSelfHostedStreaming({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  createStreaming = () => new OrukeetStreaming({ timeoutMs: CHECK_TIMEOUT_MS }),
  now = () => performance.now(),
}) {
  const trimmedUrl = typeof baseUrl === "string" ? baseUrl.trim() : "";
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  try {
    streamingUrl(trimmedUrl);
  } catch (error) {
    const invalid = { ok: false, ms: null, error: classifyStreamError(error) };
    return { http: { ...invalid, status: null }, stream: invalid };
  }
  const [http, stream] = await Promise.all([
    checkHttp({ baseUrl: trimmedUrl, apiKey: key, fetchImpl, now }),
    checkStream({ baseUrl: trimmedUrl, apiKey: key, createStreaming, now }),
  ]);
  return { http, stream };
}

module.exports = { checkSelfHostedStreaming, classifyStreamError, modelsUrl };
