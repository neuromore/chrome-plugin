/* global document, window */
// End-to-end tests: the shipped extension/ folder in real Chromium against tools/mock-studio.js.
//
// How the popup gets activeTab: CDP's Extensions.triggerAction runs the toolbar action on a tab,
// so these tests use the real popup with the real grant and the unmodified manifest. It is not a
// physical click on the icon, and the mock is not Studio.
//
// All tests share port 4547, which the extension hard-codes, so they must stay in this one file:
// node:test runs the tests of a file one at a time but runs separate files in parallel.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeFrame, message } from "../../tools/mock-studio.js";
import {
  EXTENSION_DIR,
  ORIGINAL_BODY_STYLE,
  ORIGINAL_VOLUME,
  launchBrowser,
  renderedRed,
  startMockStudio,
  startPageServer,
  testPageHtml,
  waitFor,
} from "./helpers.js";

const SCREENSHOT = join(dirname(fileURLToPath(import.meta.url)), "../../docs/images/popup.png");

const ERROR_CANNOT_CONNECT = /^Could not connect\./;
const ERROR_CANNOT_INJECT = /^Cannot connect on this page\./;

// Long enough for a second socket or a stray frame to show up if one were coming.
const SETTLE_MS = 500;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

/** Starts everything a test needs and stops it when the test ends. */
async function setup(t, { studio: studioOptions = {}, browser: browserOptions = {} } = {}) {
  const pages = await startPageServer();
  t.after(() => pages.close());
  const browser = await launchBrowser(
    typeof browserOptions === "function" ? browserOptions(pages) : browserOptions,
  );
  t.after(() => browser.close());
  const page = browser.context.pages()[0];
  const sockets = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));

  let studio = null;
  const startStudio = async (extra = {}) => {
    studio = await startMockStudio({ ...studioOptions, ...extra });
    t.after(() => studio.close());
    return studio;
  };
  if (studioOptions) await startStudio();

  return {
    pages,
    browser,
    page,
    sockets,
    startStudio,
    get studio() {
      return studio;
    },
  };
}

function pageState(page) {
  return page.evaluate(() => ({
    style: document.body.getAttribute("style"),
    filter: document.body.style.filter,
    videoVolume: document.getElementById("video").volume,
    audioVolume: document.getElementById("audio").volume,
  }));
}

const showsBrightness = (page, level) =>
  waitFor(
    async () => (await pageState(page)).filter === `brightness(${level})`,
    `body filter brightness(${level})`,
  );

const showsVolume = (page, level) =>
  waitFor(async () => {
    const state = await pageState(page);
    return state.videoVolume === level && state.audioVolume === level;
  }, `media volume ${level}`);

const isRestored = (page) =>
  waitFor(async () => {
    const state = await pageState(page);
    return (
      state.style === ORIGINAL_BODY_STYLE &&
      state.videoVolume === ORIGINAL_VOLUME &&
      state.audioVolume === ORIGINAL_VOLUME
    );
  }, "the page to be restored");

const popupShowsConnected = (popup) =>
  waitFor(async () => (await popup.text("#connectButton")) === "Connected", "Connected in popup");

const popupShowsDisconnected = (popup) =>
  waitFor(async () => (await popup.text("#connectButton")) === "Connect", "Connect in popup");

const popupError = (popup) =>
  waitFor(() => popup.text("#connection-error"), "an error message in the popup");

/** Opens the page and the toolbar popup on it, then clicks Connect and waits for the session. */
async function connect(env, path = "/") {
  await env.page.goto(`${env.pages.origin}${path}`);
  const popup = await env.browser.openPopup(env.page);
  await popup.click("#connectButton");
  await popupShowsConnected(popup);
  return popup;
}

function assertClean(env, popup) {
  assert.deepEqual(env.browser.pageProblems, [], "page console errors and warnings");
  assert.deepEqual(popup.problems, [], "popup console output and errors");
}

describe("the shipped extension", () => {
  test("loads from extension/ with only activeTab and scripting", async (t) => {
    const env = await setup(t, { studio: null });
    const { extension } = env.browser;
    assert.equal(extension.enabled, true);
    assert.equal(
      extension.version,
      JSON.parse(await readFile(join(EXTENSION_DIR, "manifest.json"), "utf8")).version,
    );
    assert.deepEqual([...extension.permissions].sort(), ["activeTab", "scripting"]);
    assert.deepEqual(extension.hostPermissions, []);
  });
});

describe("connecting", () => {
  test("clicking Connect repeatedly makes exactly one socket", async (t) => {
    const env = await setup(t);
    await env.page.goto(`${env.pages.origin}/`);
    const popup = await env.browser.openPopup(env.page);

    // All five clicks land before the first socket opens, while the button is still enabled.
    await popup.evaluate(`{
      const button = document.getElementById("connectButton");
      for (let i = 0; i < 5; i++) button.click();
    }`);
    await popupShowsConnected(popup);
    await settle();
    assert.equal(env.studio.connectionCount(), 1, "connections the mock accepted");
    assert.equal(env.studio.receivedOfType("ON_URL_OPENED").length, 1);
    assert.deepEqual(env.sockets, ["ws://127.0.0.1:4547/"], "sockets the page opened");

    // A connected popup disables the button, so a real click must do nothing.
    assert.equal(await popup.disabled("#connectButton"), true);
    await popup.click("#connectButton");

    // Injecting again into a connected tab reuses the socket.
    await popup.evaluate(`{
      const button = document.getElementById("connectButton");
      button.disabled = false;
      button.click();
    }`);
    await settle();
    assert.equal(env.studio.connectionCount(), 1, "connections after injecting again");
    assert.equal(env.sockets.length, 1);
    assertClean(env, popup);
  });

  test("tells Studio which URL the tab has, once", async (t) => {
    const env = await setup(t);
    const popup = await connect(env, "/?from=e2e");
    await waitFor(() => env.studio.receivedOfType("ON_URL_OPENED").length, "ON_URL_OPENED");
    assert.equal(
      env.studio.receivedOfType("ON_URL_OPENED")[0].data.url,
      `${env.pages.origin}/?from=e2e`,
    );
    assertClean(env, popup);
  });

  test("a reopened popup shows that the tab is connected", async (t) => {
    const env = await setup(t);
    const popup = await connect(env);
    await popup.close();

    const reopened = await env.browser.openPopup(env.page);
    await popupShowsConnected(reopened);
    assert.equal(await reopened.disabled("#disconnectButton"), false);
    await settle();
    assert.equal(env.studio.connectionCount(), 1);
    assertClean(env, reopened);
  });

  test("shows an error when no server is running, and can then retry", async (t) => {
    const env = await setup(t, { studio: null });
    await env.page.goto(`${env.pages.origin}/`);
    const before = await pageState(env.page);
    const popup = await env.browser.openPopup(env.page);

    await popup.click("#connectButton");
    assert.match(await popupError(popup), ERROR_CANNOT_CONNECT);
    assert.equal(await popup.text("#connectButton"), "Connect");
    assert.equal(await popup.disabled("#connectButton"), false);
    assert.deepEqual(await pageState(env.page), before, "the page must not change");

    // Chromium itself logs the refused connection. Scripts cannot silence it. Nothing else may log.
    const [refused, ...others] = env.browser.pageProblems;
    assert.match(refused, /^console\.error: WebSocket connection .*ERR_CONNECTION_REFUSED/);
    assert.deepEqual(others, []);
    assert.deepEqual(popup.problems, []);

    await env.startStudio();
    await popup.click("#connectButton");
    await popupShowsConnected(popup);
    assert.equal(await popup.text("#connection-error"), "");
    assert.equal(env.studio.connectionCount(), 1);
  });

  test("activeTab ends when the tab moves to another origin", async (t) => {
    const env = await setup(t);
    await env.page.goto(`${env.pages.origin}/`);
    const popup = await env.browser.openPopup(env.page);

    // The manifest has no host permissions, so only the toolbar grant allowed injecting here.
    await env.page.goto(`http://localhost:${env.pages.port}/`);
    await popup.click("#connectButton");
    assert.match(await popupError(popup), ERROR_CANNOT_INJECT);
    await settle();
    assert.equal(env.studio.connectionCount(), 0);
    assert.deepEqual(popup.problems, []);
  });

  test("shows an error on a browser page where injection is not allowed", async (t) => {
    const env = await setup(t);
    await env.page.goto("chrome://version");
    const popup = await env.browser.openPopup(env.page);
    await popup.click("#connectButton");
    assert.match(await popupError(popup), ERROR_CANNOT_INJECT);
    assert.equal(env.studio.connectionCount(), 0);
    assert.deepEqual(popup.problems, []);
  });
});

describe("feedback", () => {
  test("brightness and volume follow the frames that arrive", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.25, volume: 0.75 } });
    const popup = await connect(env);
    await showsBrightness(env.page, 0.25);
    await showsVolume(env.page, 0.75);

    env.studio.levels["Brightness Control"] = 0.6;
    env.studio.levels["Volume Control"] = 0.1;
    await showsBrightness(env.page, 0.6);
    await showsVolume(env.page, 0.1);

    // Studio does not clamp its samples.
    env.studio.levels["Brightness Control"] = 5;
    env.studio.levels["Volume Control"] = -3;
    await showsBrightness(env.page, 1);
    await showsVolume(env.page, 0);
    assertClean(env, popup);
  });

  test("the brightness is really rendered, and the rendering is restored", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.25 } });
    await env.page.goto(`${env.pages.origin}/`);
    const swatch = await env.page.evaluate(() => {
      const box = document.getElementById("swatch").getBoundingClientRect();
      return { x: Math.round(box.x + 50), y: Math.round(box.y + 20) };
    });
    const original = await renderedRed(env.page, swatch.x, swatch.y);

    const popup = await env.browser.openPopup(env.page);
    await popup.click("#connectButton");
    await showsBrightness(env.page, 0.25);
    const dimmed = await waitFor(async () => {
      const red = await renderedRed(env.page, swatch.x, swatch.y);
      return red < 100 && red;
    }, "the swatch to render dark");
    assert.ok(dimmed > 50, `white at brightness 0.25 should render near 64, got ${dimmed}`);

    env.studio.stopSession();
    await isRestored(env.page);
    assert.equal(await renderedRed(env.page, swatch.x, swatch.y), original);
    assertClean(env, popup);
  });

  test("covers a media element added after connecting", async (t) => {
    const env = await setup(t, { studio: { volume: 0.4 } });
    const popup = await connect(env);
    await showsVolume(env.page, 0.4);
    await env.page.evaluate(() => {
      const late = document.createElement("audio");
      late.id = "late";
      late.src = "/media.wav";
      document.body.append(late);
    });
    await waitFor(
      () => env.page.evaluate(() => document.getElementById("late").volume === 0.4),
      "the late element's volume",
    );

    env.studio.stopSession();
    await isRestored(env.page);
    assert.equal(await env.page.evaluate(() => document.getElementById("late").volume), 1);
    assertClean(env, popup);
  });

  test("ignores junk from the server and keeps working", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.3 } });
    const popup = await connect(env);
    await showsBrightness(env.page, 0.3);

    env.studio.broadcast("not json");
    env.studio.broadcast("null");
    env.studio.broadcast(message("NOT_A_REAL_MESSAGE"));
    env.studio.broadcast(message("OPEN_URL", {}));
    env.studio.broadcast(Buffer.from([1, 0, 0]));
    env.studio.broadcast(encodeFrame(99, 0.9));
    env.studio.broadcast(encodeFrame(1, Number.NaN));

    env.studio.levels["Brightness Control"] = 0.7;
    await showsBrightness(env.page, 0.7);
    assert.equal(await popup.text("#connectButton"), "Connected");

    // The content script warns about the bad messages it recognises, and nothing goes uncaught.
    assert.deepEqual(env.browser.pageProblems, [
      "console.warning: neuromore: ignored a malformed message from Studio",
      "console.warning: neuromore: ignored a malformed message from Studio",
      "console.warning: neuromore: ignored OPEN_URL that is not http or https",
    ]);
    assert.deepEqual(popup.problems, []);
  });
});

describe("restoring the page", () => {
  test("session stop restores the inline style and volume, and a new session applies again", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.25, volume: 0.75 } });
    const popup = await connect(env);
    await showsBrightness(env.page, 0.25);
    await showsVolume(env.page, 0.75);
    assert.notEqual((await pageState(env.page)).style, ORIGINAL_BODY_STYLE);

    env.studio.stopSession();
    await isRestored(env.page);
    await settle();
    await isRestored(env.page);
    assert.equal(await popup.text("#connectButton"), "Connected", "the socket stays open");

    env.studio.startSession();
    await showsBrightness(env.page, 0.25);
    await showsVolume(env.page, 0.75);
    assert.equal(env.studio.connectionCount(), 1);
    assertClean(env, popup);
  });

  test("Disconnect restores the page and closes the socket", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.25, volume: 0.75 } });
    const popup = await connect(env);
    await showsBrightness(env.page, 0.25);
    await showsVolume(env.page, 0.75);

    await popup.click("#disconnectButton");
    await isRestored(env.page);
    await popupShowsDisconnected(popup);
    assert.equal(await popup.disabled("#disconnectButton"), true);
    await settle();
    await isRestored(env.page);

    await popup.click("#connectButton");
    await popupShowsConnected(popup);
    await showsBrightness(env.page, 0.25);
    assert.equal(env.studio.connectionCount(), 2, "Connect after Disconnect opens a new socket");
    assertClean(env, popup);
  });

  test("the server going away restores the page even without a session stop", async (t) => {
    const env = await setup(t, { studio: { session: false } });
    const popup = await connect(env);

    // With no session running, close() sends no ON_SESSION_STOPPED, so only the socket's close
    // event can restore the page.
    env.studio.broadcast(
      message("ON_FEEDBACK_LAYOUT", {
        feedbacks: [{ name: "Brightness Control", sample_rate: 30, channels: ["Sine"] }],
      }),
    );
    env.studio.broadcast(encodeFrame(0, 0.2));
    await showsBrightness(env.page, 0.2);

    await env.studio.close();
    await isRestored(env.page);
    await popupShowsDisconnected(popup);
    assertClean(env, popup);
  });

  test("a page without an inline style gets no filter left behind", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.25 } });
    const popup = await connect(env, "/plain");
    await showsBrightness(env.page, 0.25);
    await popup.click("#disconnectButton");
    await waitFor(async () => (await pageState(env.page)).filter === "", "the filter to go");
    assert.equal(await env.page.evaluate(() => document.body.style.length), 0);
    assertClean(env, popup);
  });

  test("a popup left open notices when the tab reloads", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.25 } });
    const popup = await connect(env);
    await showsBrightness(env.page, 0.25);

    await env.page.reload();
    await popupShowsDisconnected(popup);
    assert.deepEqual(popup.problems, []);
  });

  test("reloading the tab drops the connection, and the popup says so", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.25 } });
    const popup = await connect(env);
    await showsBrightness(env.page, 0.25);
    await popup.close();

    await env.page.reload();
    await waitFor(
      () =>
        env.studio.connectionCount() === 1 &&
        env.studio.logs.includes("client disconnected (0 left)"),
      "the mock to see the socket close",
    );
    assert.equal((await pageState(env.page)).style, ORIGINAL_BODY_STYLE);

    const reopened = await env.browser.openPopup(env.page);
    await popupShowsDisconnected(reopened);
    assert.deepEqual(reopened.problems, []);
  });
});

describe("the player and URL messages", () => {
  // Autoplay rules depend on the user's history with a site, so this test switches them off.
  const browser = { extraArgs: ["--autoplay-policy=no-user-gesture-required"] };

  test("Studio can start, pause and finish the video, and hears about it", async (t) => {
    const env = await setup(t, { browser });
    const popup = await connect(env);
    const video = (read) => env.page.evaluate(read);
    await waitFor(() => video(() => document.getElementById("video").duration === 2), "metadata");

    env.studio.broadcast(message("BROWSER_START_PLAYER", { progress: 0.25, fullscreen: false }));
    await waitFor(
      () => env.studio.receivedOfType("ON_BROWSER_PLAYER_STARTED").length,
      "play event",
    );
    const [started] = env.studio.receivedOfType("ON_BROWSER_PLAYER_STARTED");
    assert.equal(started.data.player_type, "video");
    assert.equal(started.data.media_id, `${env.pages.origin}/media.wav`);
    assert.ok((await video(() => document.getElementById("video").currentTime)) >= 0.5);

    env.studio.broadcast(message("BROWSER_PAUSE_PLAYER"));
    await waitFor(
      () => env.studio.receivedOfType("ON_BROWSER_PLAYER_PAUSED").length,
      "pause event",
    );
    assert.equal(await video(() => document.getElementById("video").paused), true);
    const [paused] = env.studio.receivedOfType("ON_BROWSER_PLAYER_PAUSED");
    assert.ok(paused.data.progress >= 0.25 && paused.data.progress <= 1, "progress is a fraction");

    env.studio.broadcast(message("BROWSER_START_PLAYER", { progress: 0.95, fullscreen: false }));
    await waitFor(
      () => env.studio.receivedOfType("ON_BROWSER_PLAYER_STOPPED").length,
      "ended event",
    );
    const [stopped] = env.studio.receivedOfType("ON_BROWSER_PLAYER_STOPPED");
    assert.deepEqual(stopped.data, { progress: 1, reason: "media_ended" });
    assertClean(env, popup);
  });

  test("OPEN_URL opens http links with the popup blocker on, and refuses other schemes", async (t) => {
    // Playwright turns the popup blocker off by default.
    const env = await setup(t, { browser: { ignoreDefaultArgs: ["--disable-popup-blocking"] } });
    const popup = await connect(env);
    const opened = env.browser.context.waitForEvent("page");
    env.studio.broadcast(message("OPEN_URL", { url: `${env.pages.origin}/opened` }));
    const tab = await opened;
    await waitFor(() => tab.url() === `${env.pages.origin}/opened`, "the new tab's URL");
    assert.equal(await tab.evaluate(() => window.opener), null, "noopener");
    await tab.close();

    const pagesBefore = env.browser.context.pages().length;
    env.studio.broadcast(message("OPEN_URL", { url: "javascript:alert(1)" }));
    await waitFor(() => env.browser.pageProblems.length, "the refusal to be logged");
    assert.deepEqual(env.browser.pageProblems, [
      "console.warning: neuromore: ignored OPEN_URL that is not http or https",
    ]);
    assert.equal(env.browser.context.pages().length, pagesBefore);
    assert.deepEqual(popup.problems, []);
  });
});

describe("page conditions", () => {
  test("works on a page whose Content-Security-Policy forbids connections", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.25, volume: 0.75 } });
    const popup = await connect(env, "/csp");
    await showsBrightness(env.page, 0.25);
    await showsVolume(env.page, 0.75);
    await popup.click("#disconnectButton");
    await isRestored(env.page);
    assertClean(env, popup);
  });

  // A stand-in: Playwright answers for www.youtube.com, so nothing leaves this machine. The page
  // has the hostname and the container the extension looks for. It is not YouTube's real markup.
  const youTubePage = (container) =>
    testPageHtml({
      before: container
        ? `<div class="html5-video-container" style="outline: 1px solid red"></div>`
        : "",
    });

  // YouTube is a public site, so its page needs the local network permission. See below.
  async function openYouTube(env, container) {
    await env.browser.context.route("https://www.youtube.com/**", (route) =>
      new URL(route.request().url()).pathname === "/media.wav"
        ? route.abort()
        : route.fulfill({ contentType: "text/html", body: youTubePage(container) }),
    );
    await env.browser.context.grantPermissions(["local-network-access"], {
      origin: "https://www.youtube.com",
    });
    await env.page.goto("https://www.youtube.com/watch?v=stand-in");
    const popup = await env.browser.openPopup(env.page);
    await popup.click("#connectButton");
    await popupShowsConnected(popup);
    return popup;
  }

  const containerStyle = (page) =>
    page.evaluate(() => document.querySelector(".html5-video-container").getAttribute("style"));

  test("on youtube.com it dims the video container, not the body", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.25, volume: 0.75 } });
    const popup = await openYouTube(env, true);
    await waitFor(
      async () => (await containerStyle(env.page)).includes("brightness(0.25)"),
      "the container's filter",
    );
    await showsVolume(env.page, 0.75);
    assert.equal((await pageState(env.page)).style, ORIGINAL_BODY_STYLE, "the body is left alone");

    env.studio.stopSession();
    await waitFor(
      async () => (await containerStyle(env.page)) === "outline: red solid 1px;",
      "the container's style to be restored",
    );
    assert.deepEqual(popup.problems, []);
  });

  test("on youtube.com without the container it falls back to the body", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.25 } });
    const popup = await openYouTube(env, false);
    await showsBrightness(env.page, 0.25);
    assert.deepEqual(popup.problems, []);
  });
});

// Chrome's Local Network Access checks apply when a page from a public address opens a socket to
// loopback. The other tests use a page on 127.0.0.1, which the checks do not cover. Here a Chromium
// flag makes that same page count as public, which is how every real website looks to Chromium.
// These tests pin the current behaviour, and a Chromium update may change it.
describe("Local Network Access, on a page from a public address", () => {
  const publicPage = (pages) => ({
    extraArgs: [`--ip-address-space-overrides=127.0.0.1:${pages.port}=public`],
  });

  test("without the permission the socket is blocked and the popup shows the error", async (t) => {
    const env = await setup(t, { browser: publicPage });
    await env.page.goto(`${env.pages.origin}/`);
    const before = await pageState(env.page);
    const popup = await env.browser.openPopup(env.page);
    await popup.click("#connectButton");
    assert.match(await popupError(popup), ERROR_CANNOT_CONNECT);
    assert.equal(env.studio.connectionCount(), 0);
    assert.deepEqual(await pageState(env.page), before);
    assert.equal(env.browser.pageProblems.length, 1);
    assert.match(env.browser.pageProblems[0], /ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS/);
  });

  test("with the permission granted to the site the whole flow works", async (t) => {
    const env = await setup(t, {
      browser: publicPage,
      studio: { brightness: 0.25, volume: 0.75 },
    });
    await env.browser.context.grantPermissions(["local-network-access"], {
      origin: env.pages.origin,
    });
    const popup = await connect(env);
    await showsBrightness(env.page, 0.25);
    await showsVolume(env.page, 0.75);
    await popup.click("#disconnectButton");
    await isRestored(env.page);
    assertClean(env, popup);
  });

  test("host_permissions in the manifest would not lift the block", async (t) => {
    // A test-only copy. The shipped manifest must not gain host permissions.
    const copy = await mkdtemp(join(tmpdir(), "neuromore-e2e-extension-"));
    t.after(() => rm(copy, { recursive: true, force: true }));
    await cp(EXTENSION_DIR, copy, { recursive: true });
    const manifestPath = join(copy, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions = ["ws://127.0.0.1:4547/*", "http://127.0.0.1/*"];
    await writeFile(manifestPath, JSON.stringify(manifest));

    const env = await setup(t, {
      browser: (pages) => ({ ...publicPage(pages), extensionDir: copy }),
    });
    await env.page.goto(`${env.pages.origin}/`);
    const popup = await env.browser.openPopup(env.page);
    await popup.click("#connectButton");
    assert.match(await popupError(popup), ERROR_CANNOT_CONNECT);
    assert.equal(env.studio.connectionCount(), 0);
    assert.match(env.browser.pageProblems[0], /ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS/);
  });
});

describe("the popup", () => {
  test("a full session has no uncaught errors and no external requests", async (t) => {
    const env = await setup(t, { studio: { brightness: 0.8, volume: 0.6 } });
    await env.page.goto(`${env.pages.origin}/`);
    const popup = await env.browser.openPopup(env.page);

    // Attaching happens after the first load, so reload to log the requests of a whole load.
    await popup.reload();
    await popup.click("#connectButton");
    await popupShowsConnected(popup);
    await showsBrightness(env.page, 0.8);
    env.studio.stopSession();
    await isRestored(env.page);
    env.studio.startSession();
    await showsBrightness(env.page, 0.8);

    if (process.env.UPDATE_POPUP_SCREENSHOT) {
      await mkdir(dirname(SCREENSHOT), { recursive: true });
      await writeFile(SCREENSHOT, await popup.screenshot());
    }

    await popup.click("#disconnectButton");
    await isRestored(env.page);
    await popupShowsDisconnected(popup);

    assert.ok(popup.requests.length >= 3, "the log must have seen the popup's own files");
    const outside = popup.requests.filter(
      (url) => !url.startsWith(`chrome-extension://${env.browser.extension.id}/`),
    );
    assert.deepEqual(outside, [], "requests that leave the extension");
    assertClean(env, popup);
  });
});
