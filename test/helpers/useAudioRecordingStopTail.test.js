const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Records the stop the hook asks for, and holds the post-release tail open
// until the test settles it.
const FAKE_AUDIO_MANAGER_SOURCE = `
export default class FakeAudioManager {
  constructor() {
    this.voiceAgentRequested = false;
    this.translationRequested = false;
    this.sttConfig = {};
    this.state = { isRecording: true, isStreaming: false };
    this.stops = [];
    this.tail = null;
    globalThis.__stopTailAudioManager = this;
  }
  getState() {
    return this.state;
  }
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  stopRecording(options) {
    this.stops.push({ kind: "batch", options });
    globalThis.__stopTailEvents.push("stop");
    return true;
  }
  async stopStreamingRecording(options) {
    this.stops.push({ kind: "streaming", options });
    globalThis.__stopTailEvents.push("stop");
    await this.waitForRecordingTail();
    return true;
  }
  waitForRecordingTail() {
    return this.tail ? this.tail.promise : Promise.resolve(true);
  }
  holdTail() {
    let resolve;
    const promise = new Promise((next) => (resolve = next));
    this.tail = { promise, resolve };
  }
  shouldUseStreaming() {
    return false;
  }
  getRecordingAudioLevel() {
    return 0;
  }
  isSttConfigStale() {
    return false;
  }
  cleanup() {}
}
`;

const CUES_SOURCE = `
export const playStartCue = async () => {};
export const playStopCue = async () => {
  globalThis.__stopTailEvents.push("cue");
};
`;

async function mountHarness(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let forceStopListener = null;
  const noopDispose = () => () => {};
  globalThis.__stopTailEvents = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        onToggleDictation: noopDispose,
        onToggleVoiceAgent: noopDispose,
        onToggleTranslation: noopDispose,
        onStartDictation: noopDispose,
        onPrepareDictation: noopDispose,
        onCancelDictationPreparation: noopDispose,
        onStopDictation: noopDispose,
        onDictationForceStopped: (callback) => {
          forceStopListener = callback;
          return () => {};
        },
        dictationLifecycleStateChanged() {},
        setScreenContextEnabled() {},
        unregisterCancelHotkey: () => globalThis.__stopTailEvents.push("unregister-esc"),
      },
    },
  });
  const container = installHookDom(t);
  globalThis.__stopTailSettings = {
    autoPasteEnabled: true,
    useLocalWhisper: false,
    pauseMediaOnDictation: false,
    voiceAgentScreenContext: false,
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-recording-stop-tail-",
    noExternal: ["react-i18next"],
    mockModules: {
      "/helpers/audioManager": FAKE_AUDIO_MANAGER_SOURCE,
      "/utils/dictationCues": CUES_SOURCE,
      "/stores/settingsStore": "export const getSettings = () => globalThis.__stopTailSettings;",
      "/stores/policyStore": `export const usePolicyStore = {
        getState: () => ({ status: "unmanaged" }),
        subscribe: () => () => {},
      };`,
      "/utils/logger": `const noop = () => {};
        export default { trace: noop, debug: noop, info: noop, warn: noop, error: noop, logReasoning: noop };`,
      // A stable t, or the hook's mount effect re-runs and replaces its manager.
      "react-i18next": "const t = (key) => key; export const useTranslation = () => ({ t });",
    },
  });
  const { useAudioRecording } = await vite.ssrLoadModule("/hooks/useAudioRecording.js");
  const api = {};
  const pushToast = () => {};
  function Harness() {
    Object.assign(api, useAudioRecording(pushToast, { onDemoEvent() {} }));
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return {
    api,
    manager: () => globalThis.__stopTailAudioManager,
    events: () => globalThis.__stopTailEvents,
    forceStop: async (reason) => React.act(async () => forceStopListener({ reason })),
    flush: () => React.act(async () => new Promise((resolve) => setTimeout(resolve, 600))),
  };
}

for (const kind of ["batch", "streaming"]) {
  test(`a ${kind} stop plays its cue only once the tail has ended capture`, async (t) => {
    const harness = await mountHarness(t);
    const manager = harness.manager();
    manager.state = { isRecording: true, isStreaming: kind === "streaming" };
    manager.holdTail();
    let stopped;
    await React.act(async () => {
      stopped = harness.api.stopRecording();
    });
    await harness.flush();
    assert.deepEqual(manager.stops, [{ kind, options: { allowTail: true } }]);
    // Still capturing: no cue yet, and Esc can still cancel.
    assert.deepEqual(harness.events(), ["stop"]);
    assert.equal(harness.api.isStopping, true);
    // A second stop during the tail is a no-op.
    let second;
    await React.act(async () => {
      second = await harness.api.stopRecording();
    });
    assert.equal(second, false);
    assert.equal(manager.stops.length, 1);

    await React.act(async () => {
      manager.tail.resolve(true);
      await stopped;
    });
    assert.deepEqual(harness.events(), ["stop", "unregister-esc", "cue"]);
    assert.equal(harness.api.isStopping, false);
  });
}

test("a tail that ended in a cancel plays no stop cue", async (t) => {
  const harness = await mountHarness(t);
  const manager = harness.manager();
  manager.holdTail();
  let stopped;
  await React.act(async () => {
    stopped = harness.api.stopRecording();
  });
  await harness.flush();
  await React.act(async () => {
    manager.tail.resolve(false);
    await stopped;
  });
  assert.deepEqual(harness.events(), ["stop", "unregister-esc"]);
});

test("a push the main process force-stopped asks for no tail", async (t) => {
  const harness = await mountHarness(t);
  const manager = harness.manager();
  await harness.forceStop("timeout");
  await React.act(async () => {
    await harness.api.stopRecording();
  });
  assert.deepEqual(manager.stops, [{ kind: "batch", options: { allowTail: false } }]);
  assert.deepEqual(harness.events(), ["stop", "unregister-esc", "cue"]);
});
