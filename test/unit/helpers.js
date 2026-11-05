import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const EXTENSION_DIR = join(ROOT, "extension");

export function readExtensionFile(path) {
  return readFileSync(join(EXTENSION_DIR, path), "utf8");
}

/** A jsdom page with a quiet console. Scripts only run when passed to window.eval. */
export function createDom(html, url = "https://example.com/watch?v=1") {
  return new JSDOM(html, { url, runScripts: "outside-only", virtualConsole: new VirtualConsole() });
}

/** Records every socket the code under test creates, and lets a test play the server's part. */
export function installFakeWebSocket(window) {
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }
    send(message) {
      this.sent.push(message);
    }
    close() {
      this.readyState = FakeWebSocket.CLOSING;
    }
    serverOpens() {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
    }
    serverSends(data) {
      this.onmessage?.({ data });
    }
    serverCloses() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({});
    }
  }
  window.WebSocket = FakeWebSocket;
  return FakeWebSocket;
}

/** Page messages the content script sends to the popup, and listeners it registers. */
export function createFakeChrome() {
  const listeners = [];
  const sentToPopup = [];
  return {
    listeners,
    sentToPopup,
    runtime: {
      id: "test-extension-id",
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: async ({ message }) => {
        sentToPopup.push(message);
      },
    },
  };
}

/** Loads the content script into a fresh page. Call inject() again to simulate another Connect. */
export function loadContentScript({ html = "<body></body>", url } = {}) {
  const dom = createDom(html, url);
  const { window } = dom;
  const FakeWebSocket = installFakeWebSocket(window);
  const chrome = createFakeChrome();
  window.chrome = chrome;
  const warnings = [];
  window.console.warn = (...args) => warnings.push(args);

  const sources = [
    readExtensionFile("src/js/protocol.js"),
    readExtensionFile("src/js/websocket.js"),
  ];
  const inject = () => sources.forEach((source) => window.eval(source));
  inject();

  const popupSays = (message, respond = () => {}) =>
    chrome.listeners.forEach((listener) => listener({ message }, {}, respond));

  return {
    window,
    document: window.document,
    chrome,
    warnings,
    inject,
    popupSays,
    sockets: FakeWebSocket.instances,
    socket: FakeWebSocket.instances[0],
  };
}

/** Builds a binary feedback frame as Studio's createMessageCustomFeedback does. */
export function feedbackFrame(index, ...values) {
  const view = new DataView(new ArrayBuffer(4 + 8 * values.length));
  view.setUint16(0, 1, true);
  view.setUint16(2, index, true);
  values.forEach((value, i) => view.setFloat64(4 + 8 * i, value, true));
  return view.buffer;
}

export function jsonMessage(type, data = {}) {
  return JSON.stringify({ header: { type }, data });
}

export const LAYOUT = jsonMessage("ON_FEEDBACK_LAYOUT", {
  feedbacks: [
    { name: "Volume Control", sample_rate: 30.0, channels: ["Sine"] },
    { name: "Brightness Control", sample_rate: 30.0, channels: ["Sine"] },
    { name: "Fog", sample_rate: 30.0, channels: ["Sine"] },
  ],
});
export const VOLUME = 0;
export const BRIGHTNESS = 1;
export const UNKNOWN_NODE = 2;

/** Connects the first socket and delivers the layout. */
export function startSession(page) {
  page.socket.serverOpens();
  page.socket.serverSends(LAYOUT);
}
