// geometry.js is a content-script module that publishes onto `window`. It is
// pure, so the worker shares it by aliasing `window` to the worker global.
globalThis.window ??= globalThis;
importScripts("messages.js", "geometry.js");

const FULLPAGE_SLICE_LIMIT = 500;
const CDP_VERSION = "1.3";
const CDP_CHUNK_MAX_DEVICE_PX = 8192;
// How far the probe enlarges the viewport to find elements sized by it.
const VIEWPORT_PROBE_DELTA = 100;
// Chrome may resize the viewport during `captureBeyondViewport`, which grows
// anything sized in `vh`. Freezing those elements costs one extra resize; set
// to false if the spike shows the viewport holds still.
const FREEZE_VIEWPORT_SIZED_DEFAULT = true;
const WARM_TAB_CONCURRENCY = 5;
const CAPTURE_MIN_INTERVAL_MS = 600;
const CAPTURE_QUOTA_RETRIES = 2;
let lastCaptureAt = 0;
let captureThrottleQueue = Promise.resolve();

// Derived from the manifest so the injection order cannot drift from the
// declared one. geometry.js must load before its consumers, and a second
// hand-maintained copy of this list is how that ordering silently breaks.
const CONTENT_SCRIPTS = chrome.runtime.getManifest().content_scripts[0];

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

// The user can dismiss the "started debugging" bar, which detaches us mid-run.
// Record it; the render loop checks the flag between chunks.
chrome.debugger?.onDetach.addListener((source, reason) => {
  const capture = activeCaptures.get(source.tabId);
  if (capture) capture.detached = reason;
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
    await handlePreview(tabId);
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
      files: CONTENT_SCRIPTS.css,
    });
  } catch {
    // The manifest may have already injected the stylesheet.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPTS.js,
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
        const outcome = await captureFullPageViaDebugger(
          tab,
          params,
          action,
          originalScrollY,
        );
        if (outcome === "fallback") {
          await captureFullPage(tab, params, action, originalScrollY);
        }
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

function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Reads the dimensions out of a PNG's IHDR chunk without decoding the image.
// 32 base64 characters cover the first 24 bytes: signature, length, type, size.
function pngSize(base64) {
  const bytes = atob(base64.slice(0, 32));
  if (!bytes.startsWith("\x89PNG")) return null;
  const u32 = (offset) =>
    ((bytes.charCodeAt(offset) << 24) |
      (bytes.charCodeAt(offset + 1) << 16) |
      (bytes.charCodeAt(offset + 2) << 8) |
      bytes.charCodeAt(offset + 3)) >>>
    0;
  return { width: u32(16), height: u32(20) };
}

async function captureChunk(tabId, chunk, width, dpr) {
  const { data } = await cdp(tabId, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    optimizeForSpeed: true,
    clip: { x: 0, y: chunk.y, width, height: chunk.height, scale: 1 },
  });

  // The stitch places slices by arithmetic, so a render at any other scale
  // would land misaligned rather than fail.
  const size = pngSize(data);
  const expectedWidth = Math.round(width * dpr);
  const expectedHeight = Math.round(chunk.height * dpr);
  if (size?.width !== expectedWidth || size?.height !== expectedHeight) {
    throw new Error(
      `Unexpected render size ${size?.width}x${size?.height}, wanted ${expectedWidth}x${expectedHeight}`,
    );
  }
  return `data:image/png;base64,${data}`;
}

// Pins fixed elements and, when enabled, freezes anything sized by the
// viewport so the one-pass render matches what the user sees. Throws on any
// failure; the caller treats that as "fall back to stitching".
async function prepareDebuggerRender(tabId, originalScrollY) {
  await prepareTabForCapture(tabId);
  const dims = await sendToTab(tabId, { type: LassoMsg.PRELOAD_PAGE });
  if (!dims) throw new Error("Page preload failed");
  if (await bailIfCancelled(tabId, originalScrollY)) return null;

  const pin = await sendToTab(tabId, { type: LassoMsg.PIN_FIXED_ELEMENTS });
  if (!pin?.ok) throw new Error("Pinning fixed elements failed");

  if (FREEZE_VIEWPORT_SIZED_DEFAULT) {
    const snapshot = await sendToTab(tabId, {
      type: LassoMsg.VIEWPORT_SNAPSHOT,
    });
    if (!snapshot?.ok) throw new Error("Viewport snapshot failed");

    await cdp(tabId, "Emulation.setDeviceMetricsOverride", {
      width: snapshot.viewportWidth,
      height: snapshot.viewportHeight + VIEWPORT_PROBE_DELTA,
      deviceScaleFactor: 0,
      mobile: false,
    });
    try {
      const frozen = await sendToTab(tabId, {
        type: LassoMsg.FREEZE_VIEWPORT_SIZED,
        delta: VIEWPORT_PROBE_DELTA,
      });
      if (!frozen?.ok) throw new Error("Viewport freeze failed");
    } finally {
      await cdp(tabId, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
  }

  const metrics = await cdp(tabId, "Page.getLayoutMetrics");
  return {
    width: metrics.cssLayoutViewport.clientWidth,
    contentHeight: Math.max(
      metrics.cssContentSize.height,
      dims.totalHeight,
    ),
    viewportHeight: dims.viewportHeight,
    devicePixelRatio: dims.devicePixelRatio,
  };
}

// Renders the whole page in one pass through the debugger: nothing scrolls, so
// fixed elements paint once and there is no capture quota to wait on.
//
// Returns "fallback" only while nothing has been committed to the page's
// stitch. STITCH_BEGIN marks the capture inactive in the page, so a failure
// after it cannot be retried by another engine and is thrown instead.
async function captureFullPageViaDebugger(
  tab,
  params,
  action,
  originalScrollY,
) {
  const tabId = tab.id;
  if (!chrome.debugger || !/^https?:/.test(tab.url || "")) return "fallback";

  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (err) {
    console.warn("Lasso: debugger unavailable, stitching instead:", err);
    return "fallback";
  }

  const capture = activeCaptures.get(tabId);
  let rendered = false;

  try {
    let setup;
    let first;
    let chunks;
    try {
      setup = await prepareDebuggerRender(tabId, originalScrollY);
      if (!setup) return "done";

      chunks = LassoGeometry.screenshotChunks(
        setup.contentHeight,
        setup.devicePixelRatio,
        CDP_CHUNK_MAX_DEVICE_PX,
        setup.width,
      );
      if (!chunks.length) throw new Error("Nothing to render");

      // The first chunk doubles as a probe: a wrong scale shows up here, while
      // falling back is still possible.
      first = await captureChunk(
        tabId,
        chunks[0],
        setup.width,
        setup.devicePixelRatio,
      );
      if (capture?.detached) throw new Error("Debugger detached early");
    } catch (err) {
      console.warn("Lasso: one-pass render failed, stitching instead:", err);
      await releaseFixedElements(tabId);
      return "fallback";
    }

    if (await bailIfCancelled(tabId, originalScrollY)) return "done";

    const begin = await sendToTab(tabId, {
      type: LassoMsg.STITCH_BEGIN,
      totalHeight: setup.contentHeight,
      viewportHeight: setup.viewportHeight,
      sliceHeight: chunks[0].height,
      fixedHeight: true,
      devicePixelRatio: setup.devicePixelRatio,
      exportRect: params.skipCrop ? null : params.rect,
      skipCrop: !!params.skipCrop,
      action,
    });
    if (!begin?.ok) throw new Error(begin?.error || "Stitch setup failed");

    for (let i = 0; i < chunks.length; i += 1) {
      if (await bailIfCancelled(tabId, originalScrollY)) return "done";
      if (capture?.detached) {
        throw new Error("Capture stopped: the debugging bar was dismissed");
      }

      const dataURL =
        i === 0
          ? first
          : await captureChunk(
              tabId,
              chunks[i],
              setup.width,
              setup.devicePixelRatio,
            );

      const slice = await sendToTab(tabId, {
        type: LassoMsg.STITCH_SLICE,
        dataURL,
        y: chunks[i].y,
        pageHeight: setup.contentHeight,
      });
      if (!slice?.ok) throw new Error(slice?.error || "Stitching failed");
      if (slice.full) break;
    }

    rendered = true;
  } finally {
    // Detaching closes the "started debugging" bar and clears any emulation.
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  if (!rendered) return "done";

  if (await bailIfCancelled(tabId, originalScrollY)) return "done";

  await sendToTab(tabId, { type: LassoMsg.SCROLL_TO, y: originalScrollY });

  const fin = await sendToTab(tabId, { type: LassoMsg.STITCH_FINALIZE });
  if (!fin?.ok) throw new Error(fin?.error || "Stitch export failed");
  return "done";
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

    // Either the canvas filled or the slice budget ran out. Both stop the run;
    // the content script reports whether content was lost.
    if (slice.full || slices >= FULLPAGE_SLICE_LIMIT) break;

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

  const fin = await sendToTab(tab.id, { type: LassoMsg.STITCH_FINALIZE });
  if (!fin?.ok) throw new Error(fin?.error || "Stitch export failed");
}
