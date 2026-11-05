// Popup script: injects the content script into the active tab and shows its connection state.
(() => {
  const CONTENT_SCRIPT_FILES = ["src/js/protocol.js", "src/js/websocket.js"];

  const ERROR_CANNOT_INJECT =
    "Cannot connect on this page. Open a normal website, reopen the extension, then click Connect.";
  const ERROR_CANNOT_CONNECT =
    "Could not connect. Check that neuromore Studio is running on port 4547, and that this site is allowed to access your local network.";

  const connectButton = document.getElementById("connectButton");
  const disconnectButton = document.getElementById("disconnectButton");
  const errorMessage = document.getElementById("connection-error");

  let activeTabId = null;

  async function getActiveTabId() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id ?? null;
    return activeTabId;
  }

  function showError(text) {
    errorMessage.textContent = text;
  }

  function connectionEstablished() {
    connectButton.textContent = "Connected";
    connectButton.disabled = true;
    disconnectButton.disabled = false;
    showError("");
  }

  function connectionClosed() {
    connectButton.textContent = "Connect";
    connectButton.disabled = false;
    disconnectButton.disabled = true;
  }

  connectButton.addEventListener("click", async () => {
    showError("");
    try {
      await chrome.scripting.executeScript({
        target: { tabId: await getActiveTabId() },
        files: CONTENT_SCRIPT_FILES,
      });
    } catch {
      // For example chrome:// pages, the Web Store, or a tab that navigated after the popup opened.
      showError(ERROR_CANNOT_INJECT);
    }
  });

  disconnectButton.addEventListener("click", async () => {
    try {
      await chrome.tabs.sendMessage(await getActiveTabId(), { message: "disconnect" });
    } catch {
      // The content script is gone, for example after a reload, so there is nothing to close.
    }
    connectionClosed();
  });

  chrome.runtime.onMessage.addListener((request, sender) => {
    // Every connected tab reports here. Only the tab this popup controls matters.
    if (sender.tab?.id !== activeTabId) return;
    switch (request.message) {
      case "CONNECTED":
        connectionEstablished();
        break;
      case "DISCONNECTED":
        connectionClosed();
        break;
      case "ERROR":
        showError(ERROR_CANNOT_CONNECT);
        break;
    }
  });

  async function showCurrentState() {
    connectionClosed();
    try {
      const response = await chrome.tabs.sendMessage(await getActiveTabId(), {
        message: "checkState",
      });
      if (response?.connected) connectionEstablished();
    } catch {
      // No content script in this tab yet, which is the normal state before connecting.
    }
  }

  showCurrentState();
})();
