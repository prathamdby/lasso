importScripts("messages.js");

const FULLPAGE_SLICE_LIMIT = 500;
const WARM_TAB_CONCURRENCY = 5;

const CONTENT_SCRIPT_FILES = [
  "messages.js",
  "fixed-elements.js",
  "capture-pipeline.js",
  "selection-ui.js",
  "content.js",
  "hotkey.js",
];

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
  const tabIds = tabs.map((tab) => tab.id).filter(Boolean);

  for (let i = 0; i < tabIds.length; i += WARM_TAB_CONCURRENCY) {
    const batch = tabIds.slice(i, i + WARM_TAB_CONCURRENCY);
    await Promise.all(
      batch.map((tabId) => ensureInjected(tabId).catch(() => {})),
    );
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case LassoMsg.CAPTURE:
      handleCapture(msg.mode, msg.hideFixed).catch((err) =>
        console.error("Lasso capture failed:", err),
      );
      break;

    case LassoMsg.OPEN_PREVIEW:
      handlePreview(msg.hideFixed, sender.tab?.id).catch((err) =>
        console.error("Lasso preview failed:", err),
      );
      break;

    case LassoMsg.DOWNLOAD:
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
      break;

    case LassoMsg.CANCEL_CAPTURE:
      if (sender.tab?.id) {
        const token = activeCaptures.get(sender.tab.id);
        if (token) token.cancelled = true;
      }
      break;

    case LassoMsg.SELECTION_CAPTURE:
      if (sender.tab) {
        handleSelectionCapture(
          sender.tab.id,
          msg.mode,
          msg.hideFixed,
          msg.action,
        ).catch((err) => console.error("Lasso selection capture failed:", err));
      }
      break;

    default:
      break;
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
      files: CONTENT_SCRIPT_FILES,
    });
  } catch {
    // already injected
  }
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function prepareTabForCapture(tabId) {
  const response = await sendToTab(tabId, { type: LassoMsg.PREPARE_CAPTURE });
  if (!response?.ok) throw new Error("Capture preparation failed");
}

async function scrollTabTo(tabId, y) {
  const response = await sendToTab(tabId, { type: LassoMsg.SCROLL_TO, y });
  if (!response?.ok) throw new Error("Page did not settle after scrolling");
  return response;
}

async function handleCapture(mode, hideFixed) {
  const tab = await getActiveTab();
  await ensureInjected(tab.id);
  await sendToTab(tab.id, {
    type: LassoMsg.START_SELECTION,
    mode,
    hideFixed,
  });
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
  await sendToTab(tab.id, {
    type: LassoMsg.START_PREVIEW,
    hideFixed: !!hideFixed,
  });
}

async function abortCapture(tabId, tab, hideFixed, scrollY) {
  if (scrollY != null) {
    try {
      await sendToTab(tabId, { type: LassoMsg.SCROLL_TO, y: scrollY });
    } catch {
      // tab may be gone
    }
  }

  if (hideFixed) {
    try {
      await sendToTab(tabId, { type: LassoMsg.RESTORE_FIXED_ELEMENTS });
    } catch {
      // tab may be gone
    }
  }

  try {
    await sendToTab(tabId, { type: LassoMsg.CAPTURE_CANCELLED });
  } catch {
    // tab may be gone
  }
}

async function failCapture(tabId, hideFixed, scrollY, message) {
  if (scrollY != null) {
    try {
      await sendToTab(tabId, { type: LassoMsg.SCROLL_TO, y: scrollY });
    } catch {
      // tab may be gone
    }
  }

  if (hideFixed) {
    try {
      await sendToTab(tabId, { type: LassoMsg.RESTORE_FIXED_ELEMENTS });
    } catch {
      // tab may be gone
    }
  }

  try {
    await sendToTab(tabId, {
      type: LassoMsg.CAPTURE_FAILED,
      message: message || "Capture failed",
    });
  } catch {
    // tab may be gone
  }
}

async function bailIfCancelled(tabId, tab, hideFixed, scrollY) {
  if (!isCancelled(tabId)) return false;
  await abortCapture(tabId, tab, hideFixed, scrollY);
  return true;
}

async function runCapture(tabId, fn) {
  activeCaptures.set(tabId, { cancelled: false });
  try {
    await fn();
  } finally {
    activeCaptures.delete(tabId);
  }
}

async function handleSelectionCapture(tabId, mode, hideFixed, action) {
  await runCapture(tabId, async () => {
    const tab = await chrome.tabs.get(tabId);
    let originalScrollY = null;
    let fixedHidden = false;

    try {
      const params = await sendToTab(tabId, {
        type: LassoMsg.GET_CAPTURE_PARAMS,
      });

      if (await bailIfCancelled(tabId, tab, hideFixed, originalScrollY)) return;

      if (!params?.rect?.width || !params?.rect?.height) {
        throw new Error("Selection lost before capture");
      }

      if (hideFixed) {
        await sendToTab(tabId, { type: LassoMsg.HIDE_FIXED_ELEMENTS });
        fixedHidden = true;
      }

      if (await bailIfCancelled(tabId, tab, hideFixed, originalScrollY)) return;

      if (mode === "fullpage") {
        originalScrollY = (
          await sendToTab(tabId, { type: LassoMsg.GET_PAGE_DIMENSIONS })
        ).scrollY;
        await captureFullPage(tab, hideFixed, params, action, originalScrollY);
        return;
      }

      await prepareTabForCapture(tabId);

      const dataURL = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });

      if (await bailIfCancelled(tabId, tab, hideFixed, originalScrollY)) return;

      await sendToTab(tabId, {
        type: LassoMsg.CROP,
        dataURL,
        rect: params.rect,
        devicePixelRatio: params.devicePixelRatio,
        action,
      });
    } catch (err) {
      console.error("Lasso selection capture failed:", err);
      await failCapture(
        tabId,
        fixedHidden,
        originalScrollY,
        err?.message || "Capture failed",
      );
    } finally {
      if (fixedHidden) {
        try {
          await sendToTab(tabId, { type: LassoMsg.RESTORE_FIXED_ELEMENTS });
        } catch {
          // tab may be gone
        }
      }
    }
  });
}

async function captureFullPage(
  tab,
  hideFixed,
  params,
  action,
  originalScrollY,
) {
  await prepareTabForCapture(tab.id);

  if (await bailIfCancelled(tab.id, tab, hideFixed, originalScrollY)) return;

  const dims = await sendToTab(tab.id, { type: LassoMsg.GET_PAGE_DIMENSIONS });
  const { totalHeight, totalWidth, viewportHeight, devicePixelRatio } = dims;

  const captures = [];
  let y = 0;
  let truncated = false;

  while (y < totalHeight) {
    if (await bailIfCancelled(tab.id, tab, hideFixed, originalScrollY)) return;

    const scroll = await scrollTabTo(tab.id, y);
    const captureY = Number.isFinite(scroll.scrollY) ? scroll.scrollY : y;

    if (await bailIfCancelled(tab.id, tab, hideFixed, originalScrollY)) return;

    const dataURL = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
    captures.push({ dataURL, y: captureY });
    y += viewportHeight;

    if (captures.length >= FULLPAGE_SLICE_LIMIT) {
      truncated = y < totalHeight;
      break;
    }
  }

  if (await bailIfCancelled(tab.id, tab, hideFixed, originalScrollY)) return;

  await sendToTab(tab.id, { type: LassoMsg.SCROLL_TO, y: originalScrollY });

  await sendToTab(tab.id, {
    type: LassoMsg.STITCH,
    captures,
    totalWidth,
    totalHeight,
    viewportHeight,
    devicePixelRatio,
    exportRect: params.skipCrop ? null : params.rect,
    skipCrop: !!params.skipCrop,
    action,
    truncated,
  });
}
