/* global document, Image, chrome */
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { start as startStudio } from "../../tools/mock-studio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const EXTENSION_DIR = join(ROOT, "extension");
export const POPUP_FILE = "controlWidget.html";

const POLL_MS = 25;
const WAIT_MS = 10_000;

/** Polls until `check` returns something truthy and returns it. Throws with `what` on timeout. */
export async function waitFor(check, what, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  for (;;) {
    lastValue = await check();
    if (lastValue) return lastValue;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}. Last value: ${JSON.stringify(lastValue)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Two seconds of silent 8 kHz mono PCM. A real media file Chromium decodes without codecs. */
export function silentWav(seconds = 2) {
  const sampleRate = 8000;
  const dataBytes = sampleRate * seconds;
  const wav = Buffer.alloc(44 + dataBytes, 0x80);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28); // bytes per second
  wav.writeUInt16LE(1, 32); // bytes per sample
  wav.writeUInt16LE(8, 34); // bits per sample
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

export const ORIGINAL_BODY_STYLE =
  "margin: 7px; background: rgb(255, 255, 255); filter: contrast(0.9) !important;";
export const ORIGINAL_VOLUME = 0.35;

/** A page with real media elements, a white background and an inline body style to preserve. */
export function testPageHtml({ bodyStyle = ORIGINAL_BODY_STYLE, before = "" } = {}) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>neuromore e2e page</title></head>
  <body style="${bodyStyle}">
    ${before}
    <div id="swatch" style="width: 200px; height: 60px; background: rgb(255, 255, 255)"></div>
    <video id="video" src="/media.wav" preload="auto" width="160" height="90"></video>
    <audio id="audio" src="/media.wav" preload="auto"></audio>
    <script>
      for (const media of document.querySelectorAll("video, audio")) media.volume = ${ORIGINAL_VOLUME};
    </script>
  </body>
</html>`;
}

/**
 * Serves the test page on 127.0.0.1, so it is local and needs no network. `/csp` adds a strict
 * Content-Security-Policy like the ones streaming sites use, and `/plain` has no inline style.
 */
export async function startPageServer() {
  const wav = silentWav();
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    if (pathname === "/media.wav") {
      // Media elements need byte ranges to be seekable.
      const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? "");
      const from = match ? Number(match[1]) : 0;
      const to = match?.[2] ? Number(match[2]) : wav.length - 1;
      response.writeHead(match ? 206 : 200, {
        "content-type": "audio/wav",
        "accept-ranges": "bytes",
        "content-length": to - from + 1,
        ...(match ? { "content-range": `bytes ${from}-${to}/${wav.length}` } : {}),
      });
      response.end(wav.subarray(from, to + 1));
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (pathname === "/csp") {
      headers["content-security-policy"] =
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src 'self'; connect-src 'none'";
    }
    response.writeHead(200, headers);
    response.end(testPageHtml(pathname === "/plain" ? { bodyStyle: "" } : {}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

/**
 * Starts the mock on Studio's real port, which the extension hard-codes. Levels come from the
 * returned `levels` object, so a test decides exactly what the page should show.
 */
export async function startMockStudio({ brightness = 0.5, volume = 0.5, ...options } = {}) {
  const levels = { "Brightness Control": brightness, "Volume Control": volume };
  const logs = [];
  let studio;
  try {
    studio = await startStudio({
      value: (feedback) => levels[feedback.name],
      intervalMs: 50,
      log: (line) => logs.push(line),
      ...options,
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      throw new Error("Port 4547 is in use. Close neuromore Studio or any mock before e2e tests.", {
        cause: error,
      });
    }
    throw error;
  }
  return {
    ...studio,
    levels,
    logs,
    connectionCount: () => logs.filter((line) => line.startsWith("client connected")).length,
    receivedOfType: (type) => studio.received.filter((entry) => entry.header?.type === type),
  };
}

/**
 * Drives the real toolbar popup through one CDP target. Playwright does not expose extension
 * popups as pages, so this speaks to the target directly over the browser session.
 */
class Popup {
  #cdp;
  #targetSessionId;
  #nextId = 1;
  #pending = new Map();
  #onMessage;
  problems = [];
  requests = [];

  constructor(cdp, targetId) {
    this.#cdp = cdp;
    this.targetId = targetId;
  }

  async attach() {
    const { sessionId } = await this.#cdp.send("Target.attachToTarget", {
      targetId: this.targetId,
      flatten: false,
    });
    this.#targetSessionId = sessionId;
    this.#onMessage = ({ sessionId: from, message }) => {
      if (from === sessionId) this.#handle(JSON.parse(message));
    };
    this.#cdp.on("Target.receivedMessageFromTarget", this.#onMessage);
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Log.enable");
    await this.send("Network.enable");
    await this.loaded();
    return this;
  }

  #handle(message) {
    if (message.id) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
      return;
    }
    const { method, params } = message;
    if (method === "Runtime.exceptionThrown") {
      this.problems.push(`exception: ${params.exceptionDetails.exception?.description}`);
    } else if (method === "Runtime.consoleAPICalled") {
      this.problems.push(`console.${params.type}: ${params.args.map((a) => a.value).join(" ")}`);
    } else if (method === "Log.entryAdded") {
      this.problems.push(`log ${params.entry.level}: ${params.entry.text}`);
    } else if (method === "Network.requestWillBeSent") {
      this.requests.push(params.request.url);
    }
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    const result = new Promise((resolve, reject) => {
      // A popup that closed never answers, so a command must not wait forever.
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`The popup did not answer ${method}. Did it close?`));
      }, WAIT_MS);
      this.#pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
    });
    this.#cdp
      .send("Target.sendMessageToTarget", {
        sessionId: this.#targetSessionId,
        message: JSON.stringify({ id, method, params }),
      })
      .catch((error) => {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending?.reject(error);
      });
    return result;
  }

  /** Runs an expression in the popup and returns its value. */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description);
    return result.value;
  }

  /** Waits until control.js has run, because a click before that has no listener to reach. */
  async loaded() {
    await waitFor(
      () => this.evaluate(`document.readyState === "complete"`).catch(() => false),
      "the popup to load",
    );
  }

  /** Reloads so the network log covers the popup's whole load. */
  async reload() {
    await this.send("Page.reload");
    await this.loaded();
  }

  /** A real mouse click at the element's centre, so a disabled button really ignores it. */
  async click(selector) {
    const { x, y } = await this.evaluate(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    const event = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...event });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...event });
  }

  text(selector) {
    return this.evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent.trim()`);
  }

  disabled(selector) {
    return this.evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled`);
  }

  async screenshot() {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(data, "base64");
  }

  /** Closes the popup the way losing focus does. */
  async close() {
    await this.evaluate("window.close()").catch(() => {});
    this.#cdp.off("Target.receivedMessageFromTarget", this.#onMessage);
    await waitFor(async () => {
      const { targetInfos } = await this.#cdp.send("Target.getTargets", { filter: [{}] });
      return !targetInfos.some((target) => target.targetId === this.targetId);
    }, "the popup to close");
  }
}

/** Red channel of one rendered pixel, read from a real screenshot. */
export async function renderedRed(page, x, y) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, 1, 1).data[0];
  }, png.toString("base64"));
}

/** A real Chromium with the shipped extension/ folder loaded unpacked in a fresh profile. */
export async function launchBrowser({
  extensionDir = EXTENSION_DIR,
  headless = true,
  extraArgs = [],
  ignoreDefaultArgs,
} = {}) {
  const profile = await mkdtemp(join(tmpdir(), "neuromore-e2e-"));
  const context = await chromium.launchPersistentContext(profile, {
    // The "chromium" channel is Chromium's new headless mode, which can load extensions.
    channel: "chromium",
    headless,
    viewport: { width: 800, height: 600 },
    ignoreDefaultArgs,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      // Allows CDP's Extensions.triggerAction, see openPopup.
      "--enable-unsafe-extension-debugging",
      ...extraArgs,
    ],
  });
  const cdp = await context.browser().newBrowserCDPSession();

  const listing = await context.newPage();
  await listing.goto("chrome://extensions");
  const extensions = await listing.evaluate(() => chrome.management.getAll());
  await listing.close();
  const extension = extensions.find((entry) => entry.name === "neuromore");
  if (!extension) throw new Error(`Extension not loaded: ${JSON.stringify(extensions)}`);

  // Collected for the page of every test: anything here fails the flow unless a test expects it.
  const pageProblems = [];
  const watchPage = (page) => {
    page.on("pageerror", (error) => pageProblems.push(`pageerror: ${error.message}`));
    page.on("console", (entry) => {
      if (entry.type() === "error" || entry.type() === "warning") {
        pageProblems.push(`console.${entry.type()}: ${entry.text()}`);
      }
    });
  };
  context.on("page", watchPage);
  context.pages().forEach(watchPage);

  /**
   * Clicks the toolbar icon for `page` through CDP's Extensions.triggerAction, which runs the
   * same action as a real click, including the activeTab grant. Returns the attached popup.
   */
  const openPopup = async (page) => {
    await page.bringToFront();
    const url = page.url();
    const targets = async () => (await cdp.send("Target.getTargets", { filter: [{}] })).targetInfos;
    const tab = (await targets()).find((target) => target.type === "tab" && target.url === url);
    if (!tab) throw new Error(`No tab target for ${url}`);
    await cdp.send("Extensions.triggerAction", { id: extension.id, targetId: tab.targetId });
    const target = await waitFor(
      async () =>
        (await targets()).find(
          (entry) => entry.type === "page" && entry.url.endsWith(`/${POPUP_FILE}`),
        ),
      "the toolbar popup to open",
    );
    return new Popup(cdp, target.targetId).attach();
  };

  return {
    context,
    cdp,
    extension,
    openPopup,
    pageProblems,
    close: async () => {
      await context.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
