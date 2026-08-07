importScripts("messages.js");

const FULLPAGE_SLICE_LIMIT = 500;
const WARM_TAB_CONCURRENCY = 5;
const CAPTURE_MIN_INTERVAL_MS = 600;
const CAPTURE_QUOTA_RETRIES = 2;
let lastCaptureAt = 0;
let captureThrottleQueue = Promise.resolve();

const CONTENT_SCRIPT_FILES = [
  "messages.js",
  "geometry.js",
  "fixed-elements.js",
  "capture-pipeline.js",
  "selection-ui.js",
  "content.js",
  "hotkey.js",
];

const activeCaptures = new Map();
const previewDebounce = new Map();
const pendingBlobRevokes = new Map();
const PREVIEW_DEBOUNCE_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCaptureQuotaError(err) {
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(
    err?.message || "",
  );
}

async function captureVisibleTabThrottled(windowId) {
  for (let attempt = 0; ; attempt += 1) {
    await waitForCaptureThrottle();

    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (err) {
      if (!isCaptureQuotaError(err) || attempt >= CAPTURE_QUOTA_RETRIES) {
        throw err;
      }
      await sleep(CAPTURE_MIN_INTERVAL_MS);
    }
  }
}

async function waitForCaptureThrottle() {
  const previous = captureThrottleQueue;
  let release;
  captureThrottleQueue = new Promise((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
  } finally {
    release();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  warmOpenTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  warmOpenTabs().catch(() => {});
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "open-preview") return;
  handleCommandPreview();
});

async function handleCommandPreview() {
  let tabId;
  try {
    const tab = await getActiveTab();
    tabId = tab.id;
    await handlePreview(false, tabId);
  } catch (err) {
    console.error("Lasso preview failed:", err);
    showActionError(tabId, "Can't capture this page");
  }
}

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
      handleCapture(msg.mode).catch(async (err) => {
        console.error("Lasso capture failed:", err);
        let tabId = sender.tab?.id;
        if (tabId == null) {
          try {
            tabId = (await getActiveTab()).id;
          } catch {
            // Fall back to the global badge when there is no active tab.
          }
        }
        showActionError(tabId, "Can't capture this page");
      });
      break;

    case LassoMsg.OPEN_PREVIEW:
      handlePreview(sender.tab?.id).catch((err) => {
        console.error("Lasso preview failed:", err);
        showActionError(sender.tab?.id, "Can't capture this page");
      });
      break;

    case LassoMsg.DOWNLOAD:
      chrome.downloads.download(
        {
          url: msg.url,
          filename: msg.filename || "screenshot.png",
          saveAs: false,
        },
        (downloadId) => {
          if (!msg.revoke || sender.tab?.id == null) return;
          if (downloadId == null) {
            sendToTab(sender.tab.id, {
              type: LassoMsg.REVOKE_BLOB_URL,
              url: msg.url,
            }).catch(() => {
              // tab gone; navigation already released the blob
            });
            return;
          }
          pendingBlobRevokes.set(downloadId, {
            tabId: sender.tab.id,
            url: msg.url,
          });
          chrome.downloads.search({ id: downloadId }, (items) => {
            const state = items?.[0]?.state;
            if (state === "complete" || state === "interrupted") {
              revokePendingBlobUrl(downloadId);
            }
          });
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
        handleSelectionCapture(sender.tab.id, msg.mode, msg.action).catch(
          (err) => console.error("Lasso selection capture failed:", err),
        );
      }
      break;

    default:
      break;
  }

  return false;
});

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;

  revokePendingBlobUrl(delta.id);
});

function revokePendingBlobUrl(downloadId) {
  const pending = pendingBlobRevokes.get(downloadId);
  if (!pending) return;
  pendingBlobRevokes.delete(downloadId);

  sendToTab(pending.tabId, {
    type: LassoMsg.REVOKE_BLOB_URL,
    url: pending.url,
  }).catch(() => {
    // tab gone; navigation already released the blob
  });
}

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
    // The manifest may have already injected the stylesheet.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES,
    });
  } catch {
    // The manifest may have already injected the content scripts.
  }
}

const BADGE_CLEAR_MS = 4000;
const BADGE_CLEAR_ALARM_PREFIX = "lasso-clear-action-error:";

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(BADGE_CLEAR_ALARM_PREFIX)) return;

  const targetKey = alarm.name.slice(BADGE_CLEAR_ALARM_PREFIX.length);
  const tabId = targetKey === "default" ? undefined : Number(targetKey);
  if (tabId != null && Number.isNaN(tabId)) return;

  clearActionError(tabId);
});

function getActionErrorTarget(tabId) {
  return tabId != null ? { tabId } : {};
}

function getBadgeClearAlarmName(tabId) {
  return `${BADGE_CLEAR_ALARM_PREFIX}${tabId ?? "default"}`;
}

function showActionError(tabId, message) {
  const target = getActionErrorTarget(tabId);
  chrome.action.setBadgeBackgroundColor({ ...target, color: "#d93025" });
  chrome.action.setBadgeText({ ...target, text: "!" });
  chrome.action.setTitle({ ...target, title: `Lasso: ${message}` });
  chrome.alarms.create(getBadgeClearAlarmName(tabId), {
    when: Date.now() + BADGE_CLEAR_MS,
  });
}

function clearActionError(tabId) {
  const target = getActionErrorTarget(tabId);
  chrome.action.setBadgeText({ ...target, text: "" });
  chrome.action.setTitle({ ...target, title: "Lasso" });
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
  if (!response?.ok && !Number.isFinite(response?.scrollY)) {
    throw new Error("Page did not settle after scrolling");
  }
  return response;
}

async function handleCapture(mode) {
  const tab = await getActiveTab();
  await ensureInjected(tab.id);
  await sendToTab(tab.id, {
    type: LassoMsg.START_SELECTION,
    mode,
  });
}

async function handlePreview(preferredTabId) {
  const tab = preferredTabId
    ? await chrome.tabs.get(preferredTabId)
    : await getActiveTab();
  if (!tab?.id) throw new Error("No target tab");

  const now = Date.now();
  const last = previewDebounce.get(tab.id) || 0;
  if (now - last < PREVIEW_DEBOUNCE_MS) return;
  previewDebounce.set(tab.id, now);

  await ensureInjected(tab.id);
  await sendToTab(tab.id, { type: LassoMsg.START_PREVIEW });
}

// Releasing is idempotent and a no-op when nothing was pinned, so every exit
// path can call it unconditionally.
async function releaseFixedElements(tabId) {
  try {
    await sendToTab(tabId, { type: LassoMsg.RELEASE_FIXED_ELEMENTS });
  } catch {
    // tab may be gone
  }
}

async function restoreScroll(tabId, scrollY) {
  if (scrollY == null) return;
  try {
    await sendToTab(tabId, { type: LassoMsg.SCROLL_TO, y: scrollY });
  } catch {
    // tab may be gone
  }
}

async function abortCapture(tabId, scrollY) {
  await restoreScroll(tabId, scrollY);
  await releaseFixedElements(tabId);

  try {
    await sendToTab(tabId, { type: LassoMsg.CAPTURE_CANCELLED });
  } catch {
    // tab may be gone
  }
}

async function failCapture(tabId, scrollY, message) {
  await restoreScroll(tabId, scrollY);
  await releaseFixedElements(tabId);

  try {
    await sendToTab(tabId, {
      type: LassoMsg.CAPTURE_FAILED,
      message: message || "Capture failed",
    });
  } catch {
    // tab may be gone
  }
}

async function bailIfCancelled(tabId, scrollY) {
  if (!isCancelled(tabId)) return false;
  await abortCapture(tabId, scrollY);
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

async function handleSelectionCapture(tabId, mode, action) {
  await runCapture(tabId, async () => {
    const tab = await chrome.tabs.get(tabId);
    let originalScrollY = null;

    try {
      const params = await sendToTab(tabId, {
        type: LassoMsg.GET_CAPTURE_PARAMS,
      });

      if (await bailIfCancelled(tabId, originalScrollY)) return;

      if (!params?.rect?.width || !params?.rect?.height) {
        throw new Error("Selection lost before capture");
      }

      // Only full page scrolls, so only full page repeats fixed elements across
      // slices. Every other mode captures what is already on screen.
      if (mode === "fullpage") {
        originalScrollY = (
          await sendToTab(tabId, { type: LassoMsg.GET_PAGE_DIMENSIONS })
        ).scrollY;
        await captureFullPage(tab, params, action, originalScrollY);
        return;
      }

      await prepareTabForCapture(tabId);

      const dataURL = await captureVisibleTabThrottled(tab.windowId);

      if (await bailIfCancelled(tabId, originalScrollY)) return;

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
        originalScrollY,
        err?.message || "Capture failed",
      );
    } finally {
      await releaseFixedElements(tabId);
    }
  });
}

async function captureFullPage(tab, params, action, originalScrollY) {
  await prepareTabForCapture(tab.id);

  if (await bailIfCancelled(tab.id, originalScrollY)) return;

  const dims = await sendToTab(tab.id, { type: LassoMsg.GET_PAGE_DIMENSIONS });
  const { totalHeight, viewportHeight, devicePixelRatio } = dims;

  const begin = await sendToTab(tab.id, {
    type: LassoMsg.STITCH_BEGIN,
    totalHeight,
    viewportHeight,
    devicePixelRatio,
    exportRect: params.skipCrop ? null : params.rect,
    skipCrop: !!params.skipCrop,
    action,
  });
  if (!begin?.ok) throw new Error(begin?.error || "Stitch setup failed");

  let y = 0;
  let slices = 0;
  let pageHeight = totalHeight;
  let truncated = false;

  while (y < pageHeight) {
    if (await bailIfCancelled(tab.id, originalScrollY)) return;

    const scroll = await scrollTabTo(tab.id, y);
    const captureY = Number.isFinite(scroll.scrollY) ? scroll.scrollY : y;

    // Pin after every scroll, not just once. Plenty of navbars are static at the
    // top and only turn fixed past a scroll threshold; a single sweep at y=0
    // never sees them.
    try {
      await sendToTab(tab.id, { type: LassoMsg.PIN_FIXED_ELEMENTS });
    } catch {
      // tab may be gone; the bail check below reports it
    }

    if (await bailIfCancelled(tab.id, originalScrollY)) return;

    const dataURL = await captureVisibleTabThrottled(tab.windowId);
    const slice = await sendToTab(tab.id, {
      type: LassoMsg.STITCH_SLICE,
      dataURL,
      y: captureY,
      pageHeight,
    });
    if (!slice?.ok) throw new Error(slice?.error || "Stitching failed");

    slices += 1;
    y += viewportHeight;

    // Either the canvas filled or the slice budget ran out. Both stop the run,
    // and both drop content if the page had further to go.
    if (slice.full || slices >= FULLPAGE_SLICE_LIMIT) {
      truncated = y < pageHeight;
      break;
    }

    // Lazy-loading pages grow as they scroll. Only ever grow the bound —
    // shrinking it would end the run early, and trailing blank canvas is
    // already cropped at finalize.
    const next = await sendToTab(tab.id, {
      type: LassoMsg.GET_PAGE_DIMENSIONS,
    });
    if (Number.isFinite(next?.totalHeight) && next.totalHeight > pageHeight) {
      pageHeight = next.totalHeight;
    }
  }

  if (await bailIfCancelled(tab.id, originalScrollY)) return;

  await sendToTab(tab.id, { type: LassoMsg.SCROLL_TO, y: originalScrollY });

  const fin = await sendToTab(tab.id, {
    type: LassoMsg.STITCH_FINALIZE,
    truncated,
  });
  if (!fin?.ok) throw new Error(fin?.error || "Stitch export failed");
}
