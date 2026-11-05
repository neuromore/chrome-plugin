// Content script: connects to neuromore Studio and applies its feedback to this tab.
// The popup injects this file on every Connect click, and repeated injections share one
// isolated world, so only the first one sets up state. Later ones reuse it.
(() => {
  if (globalThis.neuromoreContentScript) {
    globalThis.neuromoreContentScript.connect();
    return;
  }

  const {
    parseFeedbackFrame,
    parseJsonMessage,
    createMessage,
    clampUnit,
    seekSeconds,
    playbackProgress,
    httpUrlOrNull,
    isYouTubeHost,
  } = globalThis.neuromoreProtocol;

  const WS_URI = "ws://127.0.0.1:4547";

  // Studio identifies nodes in the layout only by their instance name.
  const BRIGHTNESS_NODE = "Brightness Control";
  const VOLUME_NODE = "Volume Control";

  let websocket = null;
  let feedbackLayout = [];

  // What the page had before Studio changed it, restored when the session or connection ends.
  const savedFilters = new Map();
  const savedVolumes = new Map();

  function notifyPopup(message) {
    try {
      // Rejects when the popup is closed, which is the normal case.
      chrome.runtime.sendMessage({ message }).catch(() => {});
    } catch {
      // The extension was reloaded and this script is orphaned: there is no popup to notify.
    }
  }

  function sendToStudio(message) {
    if (websocket?.readyState === WebSocket.OPEN) websocket.send(message);
  }

  // page changes

  function brightnessTarget() {
    if (isYouTubeHost(location.hostname)) {
      const container = document.querySelector(".html5-video-container");
      if (container) return container;
    }
    return document.body;
  }

  function restoreFilter(element) {
    const { value, priority } = savedFilters.get(element);
    if (value) element.style.setProperty("filter", value, priority);
    else element.style.removeProperty("filter");
    savedFilters.delete(element);
  }

  function applyBrightness(level) {
    const target = brightnessTarget();
    if (!target) return;
    // The target can change while a page loads. Never dim two nested elements at once.
    for (const element of savedFilters.keys()) {
      if (element !== target) restoreFilter(element);
    }
    if (!savedFilters.has(target)) {
      savedFilters.set(target, {
        value: target.style.getPropertyValue("filter"),
        priority: target.style.getPropertyPriority("filter"),
      });
    }
    target.style.setProperty("filter", `brightness(${level})`);
  }

  function applyVolume(level) {
    for (const media of document.querySelectorAll("audio, video")) {
      if (!savedVolumes.has(media)) savedVolumes.set(media, media.volume);
      media.volume = level;
    }
  }

  function restorePage() {
    for (const element of savedFilters.keys()) restoreFilter(element);
    for (const [media, volume] of savedVolumes) media.volume = volume;
    savedVolumes.clear();
  }

  function applyFeedback(frame) {
    const name = feedbackLayout[frame.index]?.name;
    // All channels of a frame repeat channel 0, so only the first value matters.
    const level = clampUnit(frame.values[0]);
    if (level === null) return;
    if (name === BRIGHTNESS_NODE) applyBrightness(level);
    else if (name === VOLUME_NODE) applyVolume(level);
  }

  // messages from Studio

  function ignoreRejection(result) {
    Promise.resolve(result).catch((error) => {
      console.warn("neuromore: the browser refused a player request from Studio:", error);
    });
  }

  function startPlayer(data) {
    const media = document.querySelector("video");
    if (!media) return;
    const seconds = seekSeconds(data.progress, media.duration);
    if (seconds !== null) media.currentTime = seconds;
    if (data.fullscreen) ignoreRejection(media.requestFullscreen());
    ignoreRejection(media.play());
  }

  function openUrl(url) {
    const safeUrl = httpUrlOrNull(url);
    if (safeUrl) window.open(safeUrl, "_blank", "noopener");
    else console.warn("neuromore: ignored OPEN_URL that is not http or https");
  }

  function dispatchJson(text) {
    const message = parseJsonMessage(text);
    if (!message) {
      console.warn("neuromore: ignored a malformed message from Studio");
      return;
    }
    const { type, data } = message;
    switch (type) {
      case "ON_FEEDBACK_LAYOUT":
        feedbackLayout = Array.isArray(data.feedbacks) ? data.feedbacks : [];
        break;
      case "ON_SESSION_STOPPED":
        feedbackLayout = [];
        restorePage();
        break;
      case "BROWSER_START_PLAYER":
        startPlayer(data);
        break;
      case "BROWSER_PAUSE_PLAYER":
        document.querySelector("video")?.pause();
        break;
      case "OPEN_URL":
        openUrl(data.url);
        break;
    }
  }

  function dispatchMessage(message) {
    if (typeof message === "string") {
      dispatchJson(message);
      return;
    }
    const frame = parseFeedbackFrame(message);
    if (frame) applyFeedback(frame);
  }

  // connection

  function connect() {
    const state = websocket?.readyState;
    if (state === WebSocket.OPEN) {
      notifyPopup("CONNECTED");
      return;
    }
    if (state === WebSocket.CONNECTING) return;

    let socket;
    try {
      socket = new WebSocket(WS_URI);
    } catch (error) {
      console.warn("neuromore: could not create the WebSocket:", error);
      notifyPopup("ERROR");
      return;
    }
    websocket = socket;
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      if (socket !== websocket) return;
      notifyPopup("CONNECTED");
      socket.send(createMessage("ON_URL_OPENED", { url: location.href }));
    };
    socket.onmessage = (event) => {
      if (socket !== websocket || socket.readyState !== WebSocket.OPEN) return;
      // The extension was reloaded or removed under this script: hand the page back.
      if (!chrome.runtime?.id) {
        disconnect();
        return;
      }
      try {
        dispatchMessage(event.data);
      } catch (error) {
        console.warn("neuromore: could not handle a message from Studio:", error);
      }
    };
    socket.onerror = () => {
      if (socket === websocket) notifyPopup("ERROR");
    };
    socket.onclose = () => {
      if (socket !== websocket) return;
      websocket = null;
      feedbackLayout = [];
      restorePage();
      notifyPopup("DISCONNECTED");
    };
  }

  function disconnect() {
    feedbackLayout = [];
    restorePage();
    websocket?.close();
  }

  // media events do not bubble, but they do pass through document in the capture phase, which
  // also covers elements added after injection and leaves the page's own handlers alone.

  function onMediaEvent(type, handler) {
    document.addEventListener(
      type,
      (event) => {
        if (event.target instanceof HTMLMediaElement) handler(event.target);
      },
      true,
    );
  }

  onMediaEvent("play", (media) => {
    sendToStudio(
      createMessage("ON_BROWSER_PLAYER_STARTED", {
        media_id: media.currentSrc,
        player_type: media.tagName === "VIDEO" ? "video" : "audio",
      }),
    );
  });
  onMediaEvent("pause", (media) => {
    sendToStudio(
      createMessage("ON_BROWSER_PLAYER_PAUSED", {
        progress: playbackProgress(media.currentTime, media.duration),
      }),
    );
  });
  onMediaEvent("ended", () => {
    sendToStudio(
      createMessage("ON_BROWSER_PLAYER_STOPPED", { progress: 1, reason: "media_ended" }),
    );
  });

  // The socket's close event doesn't reach the popup while the page unloads.
  window.addEventListener("pagehide", () => {
    if (websocket) notifyPopup("DISCONNECTED");
  });

  // messages from the popup

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.tab) return;
    if (request.message === "disconnect") {
      disconnect();
      sendResponse({});
    } else if (request.message === "checkState") {
      sendResponse({ connected: websocket?.readyState === WebSocket.OPEN });
    }
  });

  globalThis.neuromoreContentScript = { connect };
  connect();
})();
