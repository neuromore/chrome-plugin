import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXTENSION_DIR, createDom, readExtensionFile } from "./helpers.js";

const TAB_ID = 5;
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function loadPopup({ checkState = async () => ({ connected: false }) } = {}) {
  const dom = createDom(
    readExtensionFile("controlWidget.html"),
    "chrome-extension://id/popup.html",
  );
  const { window } = dom;
  const listeners = [];
  const injected = [];
  const sentToTab = [];
  const chrome = {
    tabs: {
      query: async () => [{ id: TAB_ID }],
      sendMessage: async (tabId, { message }) => {
        sentToTab.push({ tabId, message });
        return message === "checkState" ? checkState() : {};
      },
    },
    scripting: {
      executeScript: async (options) => void injected.push(options),
    },
    runtime: { onMessage: { addListener: (listener) => listeners.push(listener) } },
  };
  window.chrome = chrome;
  window.eval(readExtensionFile("src/js/control.js"));
  await flush();

  const element = (id) => window.document.getElementById(id);
  return {
    chrome,
    injected,
    sentToTab,
    connect: element("connectButton"),
    disconnect: element("disconnectButton"),
    error: element("connection-error"),
    fromTab: (message, tabId = TAB_ID) =>
      listeners.forEach((listener) => listener({ message }, { tab: { id: tabId } })),
    click: async (button) => {
      button.click();
      await flush();
    },
  };
}

const assertClosed = (popup) => {
  assert.equal(popup.connect.textContent, "Connect");
  assert.equal(popup.connect.disabled, false);
  assert.equal(popup.disconnect.disabled, true);
};

const assertConnected = (popup) => {
  assert.equal(popup.connect.textContent, "Connected");
  assert.equal(popup.connect.disabled, true);
  assert.equal(popup.disconnect.disabled, false);
};

describe("popup state on opening", () => {
  it("shows connected when the content script reports an open socket", async () => {
    assertConnected(await loadPopup({ checkState: async () => ({ connected: true }) }));
  });

  it("shows closed when the content script reports no socket", async () => {
    assertClosed(await loadPopup());
  });

  it("shows closed with no error on a page with no content script", async () => {
    const popup = await loadPopup({
      checkState: () => Promise.reject(new Error("Receiving end does not exist.")),
    });
    assertClosed(popup);
    assert.equal(popup.error.textContent, "");
  });

  it("does not throw when a listener answers with nothing", async () => {
    assertClosed(await loadPopup({ checkState: async () => undefined }));
  });
});

describe("connecting from the popup", () => {
  it("injects the helpers first and then the content script, into the active tab", async () => {
    const popup = await loadPopup();
    await popup.click(popup.connect);
    assert.equal(popup.injected.length, 1);
    assert.equal(popup.injected[0].target.tabId, TAB_ID);
    assert.deepEqual([...popup.injected[0].files], ["src/js/protocol.js", "src/js/websocket.js"]);
  });

  it("injects only files that exist", async () => {
    const popup = await loadPopup();
    await popup.click(popup.connect);
    for (const file of popup.injected[0].files) {
      assert.ok(existsSync(join(EXTENSION_DIR, file)), file);
    }
  });

  it("shows a clear message where injection is not allowed", async () => {
    const popup = await loadPopup();
    popup.chrome.scripting.executeScript = () =>
      Promise.reject(new Error("Cannot access a chrome:// URL"));
    await popup.click(popup.connect);
    assert.match(popup.error.textContent, /Cannot connect on this page/);
    assertClosed(popup);
  });

  it("clears the previous error on the next attempt", async () => {
    const popup = await loadPopup();
    popup.fromTab("ERROR");
    assert.notEqual(popup.error.textContent, "");
    await popup.click(popup.connect);
    assert.equal(popup.error.textContent, "");
  });
});

describe("disconnecting from the popup", () => {
  const connectedPopup = () => loadPopup({ checkState: async () => ({ connected: true }) });

  it("tells the active tab and shows closed", async () => {
    const popup = await connectedPopup();
    await popup.click(popup.disconnect);
    assert.deepEqual(popup.sentToTab.at(-1), { tabId: TAB_ID, message: "disconnect" });
    assertClosed(popup);
  });

  it("shows closed when the content script has gone", async () => {
    const popup = await connectedPopup();
    popup.chrome.tabs.sendMessage = () =>
      Promise.reject(new Error("Receiving end does not exist."));
    await popup.click(popup.disconnect);
    assertClosed(popup);
  });
});

describe("messages from content scripts", () => {
  it("follows the active tab's connection state", async () => {
    const popup = await loadPopup();
    popup.fromTab("CONNECTED");
    assertConnected(popup);
    popup.fromTab("DISCONNECTED");
    assertClosed(popup);
  });

  it("explains a failed connection in terms of Studio", async () => {
    const popup = await loadPopup();
    popup.fromTab("ERROR");
    assert.match(popup.error.textContent, /Studio is running/);
    // Chrome's Local Network Access block gives the same socket error as a stopped Studio.
    assert.match(popup.error.textContent, /allowed to access your local network/);
    assert.match(popup.error.textContent, /4547/);
  });

  it("clears the error once connected", async () => {
    const popup = await loadPopup();
    popup.fromTab("ERROR");
    popup.fromTab("CONNECTED");
    assert.equal(popup.error.textContent, "");
  });

  it("ignores other tabs", async () => {
    const popup = await loadPopup();
    popup.fromTab("CONNECTED", TAB_ID + 1);
    assertClosed(popup);
    popup.fromTab("ERROR", TAB_ID + 1);
    assert.equal(popup.error.textContent, "");
  });
});
