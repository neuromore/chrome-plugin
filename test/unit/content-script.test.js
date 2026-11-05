import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BRIGHTNESS,
  LAYOUT,
  UNKNOWN_NODE,
  VOLUME,
  feedbackFrame,
  jsonMessage,
  loadContentScript,
  startSession,
} from "./helpers.js";

const sessionPage = (options) => {
  const page = loadContentScript(options);
  startSession(page);
  return page;
};

const filterOf = (element) => element.style.getPropertyValue("filter");

/** The handler's catch-all also stops exceptions, so a clean case must not have relied on it. */
const assertNoCaughtException = (page) => {
  const caught = page.warnings.filter(([text]) => String(text).includes("could not handle"));
  assert.deepEqual(caught, []);
};

/** Stubs what jsdom does not implement on a media element and records the calls. */
function stubPlayer(media, { duration = 200 } = {}) {
  const calls = [];
  Object.defineProperty(media, "duration", { value: duration, configurable: true });
  media.play = async () => void calls.push("play");
  media.pause = () => void calls.push("pause");
  media.requestFullscreen = async () => void calls.push("fullscreen");
  return calls;
}

describe("connecting", () => {
  it("opens one binary socket to Studio's default port", () => {
    const { sockets, socket } = loadContentScript();
    assert.equal(sockets.length, 1);
    assert.equal(socket.url, "ws://127.0.0.1:4547");
    assert.equal(socket.binaryType, "arraybuffer");
  });

  it("tells Studio the URL and the popup the state once open", () => {
    const { socket, chrome } = sessionPage();
    assert.deepEqual(JSON.parse(socket.sent[0]), {
      header: { type: "ON_URL_OPENED" },
      data: { url: "https://example.com/watch?v=1" },
    });
    assert.deepEqual(chrome.sentToPopup, ["CONNECTED"]);
  });

  it("reports an error to the popup when the socket constructor throws", () => {
    const dom = loadContentScript();
    dom.window.neuromoreContentScript = undefined;
    dom.window.WebSocket = class {
      static CONNECTING = 0;
      static OPEN = 1;
      constructor() {
        throw new Error("blocked");
      }
    };
    assert.doesNotThrow(() => dom.inject());
    assert.equal(dom.chrome.sentToPopup.at(-1), "ERROR");
  });

  it("reports socket errors to the popup", () => {
    const { socket, chrome } = loadContentScript();
    socket.onerror({});
    assert.deepEqual(chrome.sentToPopup, ["ERROR"]);
  });
});

describe("re-injection", () => {
  it("keeps one socket and one popup listener while connecting", () => {
    const page = loadContentScript();
    page.inject();
    page.inject();
    assert.equal(page.sockets.length, 1);
    assert.equal(page.chrome.listeners.length, 1);
  });

  it("keeps one socket and repeats the state to the popup while open", () => {
    const page = sessionPage();
    page.inject();
    assert.equal(page.sockets.length, 1);
    assert.deepEqual(page.chrome.sentToPopup, ["CONNECTED", "CONNECTED"]);
  });

  it("keeps the layout, so frames still work", () => {
    const page = sessionPage();
    page.inject();
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.5));
    assert.equal(filterOf(page.document.body), "brightness(0.5)");
  });

  it("does not stack listeners over connect and disconnect cycles", () => {
    const page = sessionPage();
    page.popupSays("disconnect");
    page.socket.serverCloses();
    page.inject();
    assert.equal(page.sockets.length, 2);
    assert.equal(page.chrome.listeners.length, 1);
  });

  it("sends one message per media event", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    page.inject();
    const video = page.document.querySelector("video");
    const before = page.socket.sent.length;
    video.dispatchEvent(new page.window.Event("play"));
    assert.equal(page.socket.sent.length, before + 1);
  });

  it("ignores a socket still closing once a new one exists", () => {
    const page = sessionPage();
    page.popupSays("disconnect");
    page.inject();
    assert.equal(page.sockets.length, 2);

    const [oldSocket, newSocket] = page.sockets;
    newSocket.serverOpens();
    newSocket.serverSends(LAYOUT);
    newSocket.serverSends(feedbackFrame(BRIGHTNESS, 0.5));
    oldSocket.serverCloses();
    assert.equal(filterOf(page.document.body), "brightness(0.5)");
    assert.equal(page.chrome.sentToPopup.includes("DISCONNECTED"), false);
  });
});

describe("feedback", () => {
  it("looks the node up by its index in the layout", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    const video = page.document.querySelector("video");

    page.socket.serverSends(feedbackFrame(VOLUME, 0.25));
    assert.equal(video.volume, 0.25);
    assert.equal(filterOf(page.document.body), "");

    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.75));
    assert.equal(filterOf(page.document.body), "brightness(0.75)");
    assert.equal(video.volume, 0.25);
  });

  it("uses a later layout's order", () => {
    const page = sessionPage();
    page.socket.serverSends(
      jsonMessage("ON_FEEDBACK_LAYOUT", { feedbacks: [{ name: "Brightness Control" }] }),
    );
    page.socket.serverSends(feedbackFrame(0, 0.5));
    assert.equal(filterOf(page.document.body), "brightness(0.5)");
  });

  it("ignores nodes it does not control", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    page.socket.serverSends(feedbackFrame(UNKNOWN_NODE, 0.25));
    assert.equal(filterOf(page.document.body), "");
    assert.equal(page.document.querySelector("video").volume, 1);
  });

  it("applies volume to audio and to video elements", () => {
    const page = sessionPage({ html: "<body><audio></audio><video></video></body>" });
    page.socket.serverSends(feedbackFrame(VOLUME, 0.5));
    assert.equal(page.document.querySelector("audio").volume, 0.5);
    assert.equal(page.document.querySelector("video").volume, 0.5);
  });

  it("clamps out-of-range volume on every element", () => {
    const page = sessionPage({ html: "<body><video></video><video></video></body>" });
    const videos = [...page.document.querySelectorAll("video")];
    page.socket.serverSends(feedbackFrame(VOLUME, 5));
    assert.deepEqual(
      videos.map((v) => v.volume),
      [1, 1],
    );
    page.socket.serverSends(feedbackFrame(VOLUME, -5));
    assert.deepEqual(
      videos.map((v) => v.volume),
      [0, 0],
    );
    assert.deepEqual(page.warnings, []);
  });

  it("clamps out-of-range brightness", () => {
    const page = sessionPage();
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 5));
    assert.equal(filterOf(page.document.body), "brightness(1)");
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, -5));
    assert.equal(filterOf(page.document.body), "brightness(0)");
  });

  for (const value of [NaN, Infinity, -Infinity]) {
    it(`leaves the page alone on ${value}`, () => {
      const page = sessionPage({ html: "<body><video></video></body>" });
      page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.5));
      page.socket.serverSends(feedbackFrame(VOLUME, 0.5));
      page.socket.serverSends(feedbackFrame(BRIGHTNESS, value));
      page.socket.serverSends(feedbackFrame(VOLUME, value));
      assert.equal(filterOf(page.document.body), "brightness(0.5)");
      assert.equal(page.document.querySelector("video").volume, 0.5);
      assert.deepEqual(page.warnings, []);
    });
  }

  it("dims YouTube's video container and not the page", () => {
    const page = sessionPage({
      url: "https://www.youtube.com/watch?v=1",
      html: '<body><div class="html5-video-container"></div></body>',
    });
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.5));
    assert.equal(
      filterOf(page.document.querySelector(".html5-video-container")),
      "brightness(0.5)",
    );
    assert.equal(filterOf(page.document.body), "");
  });

  it("falls back to the page on YouTube without the container, then moves to it", () => {
    const page = sessionPage({ url: "https://www.youtube.com/" });
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.5));
    assert.equal(filterOf(page.document.body), "brightness(0.5)");

    const container = page.document.createElement("div");
    container.className = "html5-video-container";
    page.document.body.append(container);
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.25));
    assert.equal(filterOf(container), "brightness(0.25)");
    assert.equal(filterOf(page.document.body), "");
  });

  it("does not treat a URL that merely mentions youtube as YouTube", () => {
    const page = sessionPage({ url: "https://example.com/youtube" });
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.5));
    assert.equal(filterOf(page.document.body), "brightness(0.5)");
  });
});

describe("restoring the page", () => {
  const ways = {
    "the popup disconnects": (page) => page.popupSays("disconnect"),
    "the session stops": (page) => page.socket.serverSends(jsonMessage("ON_SESSION_STOPPED")),
    "the socket closes": (page) => page.socket.serverCloses(),
  };

  for (const [name, end] of Object.entries(ways)) {
    describe(`when ${name}`, () => {
      it("removes the brightness filter", () => {
        const page = sessionPage();
        page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.2));
        end(page);
        assert.equal(filterOf(page.document.body), "");
      });

      it("puts back the page's own inline styles", () => {
        const page = sessionPage({
          html: '<body style="color: red; filter: blur(2px); margin: 3px"></body>',
        });
        page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.2));
        assert.equal(filterOf(page.document.body), "brightness(0.2)");
        assert.equal(page.document.body.style.getPropertyValue("color"), "red");
        page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.3));
        end(page);
        assert.equal(filterOf(page.document.body), "blur(2px)");
        assert.equal(page.document.body.style.getPropertyValue("color"), "red");
        assert.equal(page.document.body.style.getPropertyValue("margin"), "3px");
      });

      it("puts back each element's original volume", () => {
        const page = sessionPage({ html: "<body><video></video><audio></audio></body>" });
        const video = page.document.querySelector("video");
        const audio = page.document.querySelector("audio");
        video.volume = 0.8;
        audio.volume = 0.4;
        page.socket.serverSends(feedbackFrame(VOLUME, 0.1));
        page.socket.serverSends(feedbackFrame(VOLUME, 0.2));
        end(page);
        assert.equal(video.volume, 0.8);
        assert.equal(audio.volume, 0.4);
      });
    });
  }

  it("keeps a filter priority the page set", () => {
    const page = sessionPage({ html: '<body style="filter: blur(2px) !important"></body>' });
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.2));
    page.popupSays("disconnect");
    assert.equal(filterOf(page.document.body), "blur(2px)");
    assert.equal(page.document.body.style.getPropertyPriority("filter"), "important");
  });

  it("restores once and then keeps the page's later changes", () => {
    const page = sessionPage();
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.2));
    page.socket.serverSends(jsonMessage("ON_SESSION_STOPPED"));
    page.document.body.style.setProperty("filter", "blur(1px)");
    page.popupSays("disconnect");
    page.socket.serverCloses();
    assert.equal(filterOf(page.document.body), "blur(1px)");
  });

  it("saves fresh originals for the next session", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    const video = page.document.querySelector("video");
    page.socket.serverSends(feedbackFrame(VOLUME, 0.1));
    page.socket.serverSends(jsonMessage("ON_SESSION_STOPPED"));
    video.volume = 0.6;
    page.socket.serverSends(LAYOUT);
    page.socket.serverSends(feedbackFrame(VOLUME, 0.3));
    page.socket.serverSends(jsonMessage("ON_SESSION_STOPPED"));
    assert.equal(video.volume, 0.6);
  });

  it("ignores frames that arrive after a session stopped", () => {
    const page = sessionPage();
    page.socket.serverSends(jsonMessage("ON_SESSION_STOPPED"));
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.2));
    assert.equal(filterOf(page.document.body), "");
  });

  it("ignores frames that arrive after disconnecting", () => {
    const page = sessionPage();
    page.popupSays("disconnect");
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.2));
    assert.equal(filterOf(page.document.body), "");
  });

  it("ignores frames from a closing socket once a new one has a layout", () => {
    const page = sessionPage();
    page.popupSays("disconnect");
    page.inject();
    const [oldSocket, newSocket] = page.sockets;
    newSocket.serverOpens();
    newSocket.serverSends(LAYOUT);
    oldSocket.serverSends(feedbackFrame(BRIGHTNESS, 0.2));
    assert.equal(filterOf(page.document.body), "");
  });

  it("tells the popup when the socket closes", () => {
    const page = sessionPage();
    page.socket.serverCloses();
    assert.equal(page.chrome.sentToPopup.at(-1), "DISCONNECTED");
  });

  it("closes the socket on disconnect", () => {
    const page = sessionPage();
    page.popupSays("disconnect");
    assert.equal(page.socket.readyState, page.window.WebSocket.CLOSING);
  });
});

describe("malformed input", () => {
  const assertHarmless = (send, html = "<body><video></video></body>") => {
    const page = sessionPage({ html });
    assert.doesNotThrow(() => send(page));
    assert.equal(filterOf(page.document.body), "");
    assertNoCaughtException(page);
    return page;
  };

  const texts = {
    "invalid JSON": "{not json",
    "an empty string": "",
    "JSON null": "null",
    "a JSON array": "[]",
    "no header": '{"data":{}}',
    "a null header": '{"header":null}',
    "a non-string type": '{"header":{"type":5},"data":{}}',
    "an unknown type": jsonMessage("SOMETHING_NEW"),
    "a layout with no data": '{"header":{"type":"ON_FEEDBACK_LAYOUT"}}',
    "a layout that is not an array": jsonMessage("ON_FEEDBACK_LAYOUT", { feedbacks: "x" }),
    "a player start with no data": '{"header":{"type":"BROWSER_START_PLAYER"}}',
    "an OPEN_URL with no data": '{"header":{"type":"OPEN_URL"}}',
  };
  for (const [name, text] of Object.entries(texts)) {
    it(`survives ${name}`, () => {
      assertHarmless((page) => page.socket.serverSends(text));
    });
  }

  const frames = {
    "an empty frame": new ArrayBuffer(0),
    "a truncated header": new ArrayBuffer(3),
    "a partial value": new ArrayBuffer(9),
    "a frame with no values": feedbackFrame(BRIGHTNESS),
    "an unknown id": feedbackFrame(999, 0.5),
  };
  for (const [name, frame] of Object.entries(frames)) {
    it(`survives ${name}`, () => {
      assertHarmless((page) => page.socket.serverSends(frame));
    });
  }

  it("survives a non-buffer payload", () => {
    assertHarmless((page) => page.socket.serverSends(undefined));
    assertHarmless((page) => page.socket.serverSends({}));
  });

  it("ignores frames that arrive before the layout", () => {
    const page = loadContentScript();
    page.socket.serverOpens();
    assert.doesNotThrow(() => page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.5)));
    assert.equal(filterOf(page.document.body), "");
    assertNoCaughtException(page);
  });

  it("survives null entries in the layout", () => {
    const page = loadContentScript();
    page.socket.serverOpens();
    page.socket.serverSends(jsonMessage("ON_FEEDBACK_LAYOUT", { feedbacks: [null, 3] }));
    assert.doesNotThrow(() => page.socket.serverSends(feedbackFrame(0, 0.5)));
    assert.doesNotThrow(() => page.socket.serverSends(feedbackFrame(1, 0.5)));
  });

  it("keeps working after bad input", () => {
    const page = sessionPage();
    page.socket.serverSends("{not json");
    page.socket.serverSends(feedbackFrame(999, 0.5));
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.5));
    assert.equal(filterOf(page.document.body), "brightness(0.5)");
  });

  it("does not let an unexpected exception escape the message handler", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    Object.defineProperty(page.document.querySelector("video"), "volume", {
      set() {
        throw new Error("boom");
      },
      get: () => 1,
    });
    assert.doesNotThrow(() => page.socket.serverSends(feedbackFrame(VOLUME, 0.5)));
    assert.equal(page.warnings.length, 1);
  });
});

describe("player commands", () => {
  const start = (data) => jsonMessage("BROWSER_START_PLAYER", data);

  it("does not throw when the page has no media", () => {
    const page = sessionPage();
    assert.doesNotThrow(() => page.socket.serverSends(start({ progress: 0.5, fullscreen: true })));
    assert.doesNotThrow(() => page.socket.serverSends(jsonMessage("BROWSER_PAUSE_PLAYER")));
    assertNoCaughtException(page);
  });

  it("seeks by fraction of the duration, not to seconds", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    const video = page.document.querySelector("video");
    const calls = stubPlayer(video);
    page.socket.serverSends(start({ progress: 0.5, fullscreen: false }));
    assert.equal(video.currentTime, 100);
    assert.deepEqual(calls, ["play"]);
  });

  it("does not seek when the duration is unknown, but still plays", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    const video = page.document.querySelector("video");
    const calls = stubPlayer(video, { duration: NaN });
    video.currentTime = 7;
    page.socket.serverSends(start({ progress: 0.5 }));
    assert.equal(video.currentTime, 7);
    assert.deepEqual(calls, ["play"]);
  });

  it("requests fullscreen only when asked", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    const calls = stubPlayer(page.document.querySelector("video"));
    page.socket.serverSends(start({ progress: 0, fullscreen: true }));
    assert.deepEqual(calls, ["fullscreen", "play"]);
  });

  it("handles the browser refusing to play or go fullscreen", async () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    const video = page.document.querySelector("video");
    stubPlayer(video);
    video.play = () => Promise.reject(new Error("NotAllowedError"));
    video.requestFullscreen = () => Promise.reject(new Error("NotAllowedError"));
    page.socket.serverSends(start({ progress: 0, fullscreen: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.warnings.length, 2);
  });

  it("pauses the video", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    const calls = stubPlayer(page.document.querySelector("video"));
    page.socket.serverSends(jsonMessage("BROWSER_PAUSE_PLAYER"));
    assert.deepEqual(calls, ["pause"]);
  });
});

describe("OPEN_URL", () => {
  const pageWithOpenSpy = () => {
    const page = sessionPage();
    const opened = [];
    page.window.open = (...args) => void opened.push(args);
    return { page, opened };
  };

  it("opens http and https URLs without giving them a window handle", () => {
    const { page, opened } = pageWithOpenSpy();
    page.socket.serverSends(jsonMessage("OPEN_URL", { url: "https://example.org/a" }));
    page.socket.serverSends(jsonMessage("OPEN_URL", { url: "http://example.org/b" }));
    assert.deepEqual(opened, [
      ["https://example.org/a", "_blank", "noopener"],
      ["http://example.org/b", "_blank", "noopener"],
    ]);
  });

  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "x",
    7,
    null,
  ]) {
    it(`refuses ${JSON.stringify(url)}`, () => {
      const { page, opened } = pageWithOpenSpy();
      page.socket.serverSends(jsonMessage("OPEN_URL", { url }));
      assert.deepEqual(opened, []);
      assert.equal(page.warnings.length, 1);
    });
  }
});

describe("media events", () => {
  const lastSent = (page) => JSON.parse(page.socket.sent.at(-1));

  it("reports play for media added after injection", () => {
    const page = sessionPage();
    const audio = page.document.createElement("audio");
    page.document.body.append(audio);
    audio.dispatchEvent(new page.window.Event("play"));
    assert.equal(lastSent(page).header.type, "ON_BROWSER_PLAYER_STARTED");
    assert.equal(lastSent(page).data.player_type, "audio");
  });

  it("reports a finite pause progress when the duration is unknown", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    page.document.querySelector("video").dispatchEvent(new page.window.Event("pause"));
    assert.deepEqual(lastSent(page), {
      header: { type: "ON_BROWSER_PLAYER_PAUSED" },
      data: { progress: 0 },
    });
  });

  it("reports the end of the media", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    page.document.querySelector("video").dispatchEvent(new page.window.Event("ended"));
    assert.deepEqual(lastSent(page), {
      header: { type: "ON_BROWSER_PLAYER_STOPPED" },
      data: { progress: 1, reason: "media_ended" },
    });
  });

  it("leaves the page's own handlers in place", () => {
    const page = sessionPage({ html: "<body><video></video></body>" });
    const video = page.document.querySelector("video");
    let called = 0;
    video.onpause = () => called++;
    video.dispatchEvent(new page.window.Event("pause"));
    assert.equal(called, 1);
  });

  it("sends nothing and does not throw when the socket is not open", () => {
    const page = loadContentScript({ html: "<body><video></video></body>" });
    const video = page.document.querySelector("video");
    assert.doesNotThrow(() => video.dispatchEvent(new page.window.Event("play")));
    assert.deepEqual(page.socket.sent, []);
  });
});

describe("messages from the popup", () => {
  it("answers checkState", () => {
    const page = loadContentScript();
    const answers = [];
    page.popupSays("checkState", (answer) => answers.push(answer.connected));
    page.socket.serverOpens();
    page.popupSays("checkState", (answer) => answers.push(answer.connected));
    page.socket.serverCloses();
    page.popupSays("checkState", (answer) => answers.push(answer.connected));
    assert.deepEqual(answers, [false, true, false]);
  });

  it("ignores messages sent from other tabs", () => {
    const page = sessionPage();
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.5));
    page.chrome.listeners[0]({ message: "disconnect" }, { tab: { id: 2 } }, () => {});
    assert.equal(page.socket.readyState, page.window.WebSocket.OPEN);
    assert.equal(filterOf(page.document.body), "brightness(0.5)");
  });

  it("keeps quiet when no popup is open", async () => {
    const page = loadContentScript();
    page.chrome.runtime.sendMessage = () =>
      Promise.reject(new Error("Receiving end does not exist."));
    page.socket.serverOpens();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.socket.sent.length, 1);
  });

  it("hands the page back and closes the socket once the extension is gone", () => {
    const page = loadContentScript();
    startSession(page);
    page.socket.serverSends(feedbackFrame(BRIGHTNESS, 0.5));
    assert.equal(filterOf(page.document.body), "brightness(0.5)");
    const socket = page.socket;
    delete page.chrome.runtime.id;
    socket.serverSends(feedbackFrame(BRIGHTNESS, 0.2));
    assert.equal(filterOf(page.document.body), "");
    assert.notEqual(socket.readyState, page.window.WebSocket.OPEN);
  });

  it("tells an open popup when the page unloads while connected", () => {
    const page = loadContentScript();
    page.socket.serverOpens();
    page.chrome.sentToPopup.length = 0;
    page.window.dispatchEvent(new page.window.Event("pagehide"));
    assert.deepEqual(page.chrome.sentToPopup, ["DISCONNECTED"]);
  });

  it("survives the extension being reloaded under it", () => {
    const page = loadContentScript();
    page.chrome.runtime.sendMessage = () => {
      throw new Error("Extension context invalidated.");
    };
    assert.doesNotThrow(() => page.socket.serverOpens());
    assert.equal(page.socket.sent.length, 1);
  });
});
