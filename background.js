const SCROLL_WAIT_MS = 150;

const activeCaptures = new Map();
const previewDebounce = new Map();
const PREVIEW_DEBOUNCE_MS = 400;

chrome.runtime.onInstalled.addListener(() => {
  warmOpenTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  warmOpenTabs().catch(() => {});
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-preview") return;
  handlePreview(false).catch((err) =>
    console.error("Lasso preview failed:", err),
  );
});

async function warmOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      await ensureInjected(tab.id);
    } catch {
      // restricted tab
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "capture") {
    handleCapture(msg.mode, msg.hideFixed).catch((err) =>
      console.error("Lasso capture failed:", err),
    );
    return false;
  }

  if (msg.type === "openPreview") {
    handlePreview(msg.hideFixed, sender.tab?.id).catch((err) =>
      console.error("Lasso preview failed:", err),
    );
    return false;
  }

  if (msg.type === "download") {
    chrome.downloads.download(
      {
        url: msg.url,
        filename: msg.filename || "screenshot.png",
        saveAs: false,
      },
      () => {
        if (msg.revoke) URL.revokeObjectURL(msg.url);
      },
    );
    return false;
  }

  if (msg.type === "cancelCapture" && sender.tab?.id) {
    const token = activeCaptures.get(sender.tab.id);
    if (token) token.cancelled = true;
    return false;
  }

  if (msg.type === "selectionCapture" && sender.tab) {
    handleSelectionCapture(
      sender.tab.id,
      msg.mode,
      msg.hideFixed,
      msg.action,
    ).catch((err) => console.error("Lasso selection capture failed:", err));
    return false;
  }

  return false;
});

function isCancelled(tabId) {
  return activeCaptures.get(tabId)?.cancelled === true;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab;
}

async function ensureInjected(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });
  } catch {
    // already injected
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch {
    // already injected
  }
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleCapture(mode, hideFixed) {
  const tab = await getActiveTab();
  await ensureInjected(tab.id);
  await sendToTab(tab.id, { type: "startSelection", mode, hideFixed });
}

async function handlePreview(hideFixed, preferredTabId) {
  const tab = preferredTabId
    ? await chrome.tabs.get(preferredTabId)
    : await getActiveTab();
  if (!tab?.id) throw new Error("No target tab");

  const now = Date.now();
  const last = previewDebounce.get(tab.id) || 0;
  if (now - last < PREVIEW_DEBOUNCE_MS) return;
  previewDebounce.set(tab.id, now);

  await ensureInjected(tab.id);
  await sendToTab(tab.id, { type: "startPreview", hideFixed: !!hideFixed });
}

async function abortCapture(tabId, tab, hideFixed, scrollY) {
  if (scrollY != null) {
    try {
      await sendToTab(tabId, { type: "scrollTo", y: scrollY });
    } catch {
      // tab may be gone
    }
  }

  if (hideFixed) {
    try {
      await sendToTab(tabId, { type: "restoreFixedElements" });
    } catch {
      // tab may be gone
    }
  }

  try {
    await sendToTab(tabId, { type: "captureCancelled" });
  } catch {
    // tab may be gone
  }
}

async function handleSelectionCapture(tabId, mode, hideFixed, action) {
  const token = { cancelled: false };
  activeCaptures.set(tabId, token);

  let originalScrollY = null;

  try {
    const tab = await chrome.tabs.get(tabId);
    const params = await sendToTab(tabId, { type: "getCaptureParams" });

    if (isCancelled(tabId)) {
      await abortCapture(tabId, tab, hideFixed, originalScrollY);
      return;
    }

    if (!params?.rect?.width || !params?.rect?.height) {
      throw new Error("Selection lost before capture");
    }

    if (hideFixed) {
      await sendToTab(tabId, { type: "hideFixedElements" });
      await delay(100);
    }

    if (isCancelled(tabId)) {
      await abortCapture(tabId, tab, hideFixed, originalScrollY);
      return;
    }

    if (mode === "fullpage") {
      originalScrollY = (await sendToTab(tabId, { type: "getPageDimensions" }))
        .scrollY;
      await captureFullPage(tab, hideFixed, params, action, originalScrollY);
      return;
    }

    const dataURL = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });

    if (isCancelled(tabId)) {
      await abortCapture(tabId, tab, hideFixed, originalScrollY);
      return;
    }

    await sendToTab(tabId, {
      type: "crop",
      dataURL,
      rect: params.rect,
      devicePixelRatio: params.devicePixelRatio,
      action,
    });

    if (hideFixed) {
      await sendToTab(tabId, { type: "restoreFixedElements" });
    }
  } finally {
    activeCaptures.delete(tabId);
  }
}

async function captureFullPage(
  tab,
  hideFixed,
  params,
  action,
  originalScrollY,
) {
  await sendToTab(tab.id, { type: "prepareCapture" });
  await delay(50);

  if (isCancelled(tab.id)) {
    await abortCapture(tab.id, tab, hideFixed, originalScrollY);
    return;
  }

  const dims = await sendToTab(tab.id, { type: "getPageDimensions" });
  const { totalHeight, totalWidth, viewportHeight, devicePixelRatio } = dims;

  const captures = [];
  let y = 0;

  while (y < totalHeight) {
    if (isCancelled(tab.id)) {
      await abortCapture(tab.id, tab, hideFixed, originalScrollY);
      return;
    }

    await sendToTab(tab.id, { type: "scrollTo", y });
    await delay(SCROLL_WAIT_MS);

    if (isCancelled(tab.id)) {
      await abortCapture(tab.id, tab, hideFixed, originalScrollY);
      return;
    }

    const dataURL = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    captures.push({ dataURL, y });
    y += viewportHeight;
    if (captures.length > 500) break;
  }

  if (isCancelled(tab.id)) {
    await abortCapture(tab.id, tab, hideFixed, originalScrollY);
    return;
  }

  await sendToTab(tab.id, { type: "scrollTo", y: originalScrollY });

  await sendToTab(tab.id, {
    type: "stitch",
    captures,
    totalWidth,
    totalHeight,
    viewportHeight,
    devicePixelRatio,
    exportRect: params.skipCrop ? null : params.rect,
    skipCrop: !!params.skipCrop,
    action,
  });

  if (hideFixed) {
    await sendToTab(tab.id, { type: "restoreFixedElements" });
  }
}
