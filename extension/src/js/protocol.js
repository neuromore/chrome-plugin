// Pure helpers for neuromore Studio's WebSocket protocol. Injected before websocket.js.
// Wire format reference: src/Engine/Networking/WebsocketProtocol.h in neuromore/studio.
(() => {
  const FRAME_TYPE_CUSTOM_FEEDBACK = 1;
  const FRAME_HEADER_BYTES = 4;
  const FRAME_VALUE_BYTES = 8;

  // Binary frame, little-endian: uint16 type, uint16 index into the layout's feedbacks array,
  // then one float64 per channel. Returns null for anything else.
  function parseFeedbackFrame(buffer) {
    if (Object.prototype.toString.call(buffer) !== "[object ArrayBuffer]") return null;
    const payloadBytes = buffer.byteLength - FRAME_HEADER_BYTES;
    if (payloadBytes < 0 || payloadBytes % FRAME_VALUE_BYTES !== 0) return null;

    const view = new DataView(buffer);
    if (view.getUint16(0, true) !== FRAME_TYPE_CUSTOM_FEEDBACK) return null;

    const values = [];
    for (let offset = FRAME_HEADER_BYTES; offset < buffer.byteLength; offset += FRAME_VALUE_BYTES) {
      values.push(view.getFloat64(offset, true));
    }
    return { index: view.getUint16(2, true), values };
  }

  // JSON message: {"header":{"type":T},"data":{...}}. Returns null if the text is not one.
  function parseJsonMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return null;
    }
    const type = message?.header?.type;
    if (typeof type !== "string") return null;
    const data = message.data;
    return { type, data: data !== null && typeof data === "object" ? data : {} };
  }

  function createMessage(type, data) {
    return JSON.stringify({ header: { type }, data });
  }

  // Studio sends raw samples without clamping, so values may be out of range, Inf or NaN.
  // Returns the value clamped to 0..1, or null if there is no usable number.
  function clampUnit(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
  }

  // Studio's BROWSER_START_PLAYER progress is a 0..1 fraction of the media's length.
  // Returns the time to seek to in seconds, or null if it cannot be worked out.
  function seekSeconds(progress, duration) {
    const fraction = clampUnit(progress);
    return fraction !== null && Number.isFinite(duration) ? fraction * duration : null;
  }

  // Fraction of the media already played. Duration is NaN while unknown and Infinity for streams.
  function playbackProgress(currentTime, duration) {
    return Number.isFinite(duration) && duration > 0 ? clampUnit(currentTime / duration) : 0;
  }

  // Returns the normalized URL if it is http or https, otherwise null.
  function httpUrlOrNull(url) {
    if (typeof url !== "string") return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
    } catch {
      return null;
    }
  }

  function isYouTubeHost(hostname) {
    return hostname === "youtube.com" || hostname.endsWith(".youtube.com");
  }

  globalThis.neuromoreProtocol = {
    parseFeedbackFrame,
    parseJsonMessage,
    createMessage,
    clampUnit,
    seekSeconds,
    playbackProgress,
    httpUrlOrNull,
    isYouTubeHost,
  };
})();
