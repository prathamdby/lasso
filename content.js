(() => {
  if (window.__lassoLoaded) return;
  window.__lassoLoaded = true;

  const SCROLL_SETTLE_FRAMES = 10;
  const SCROLL_STABLE_FRAMES = 3;
  const SCROLL_EPSILON = 1;
  const PRELOAD_SCROLL_BUDGET_MS = 2000;
  const PRELOAD_DECODE_BUDGET_MS = 3000;

  function nextAnimationFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function maxScrollX() {
    return Math.max(
      0,
      document.documentElement.scrollWidth - window.innerWidth,
      document.body.scrollWidth - window.innerWidth,
    );
  }

  function maxScrollY() {
    return Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight,
      document.body.scrollHeight - window.innerHeight,
    );
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function isNearScrollPosition(a, b) {
    return (
      Math.abs(a.scrollX - b.scrollX) <= SCROLL_EPSILON &&
      Math.abs(a.scrollY - b.scrollY) <= SCROLL_EPSILON
    );
  }

  function currentScroll() {
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  }

  async function scrollToPosition({ x = window.scrollX, y = window.scrollY }) {
    const targetX = clamp(x, 0, maxScrollX());
    const targetY = clamp(y, 0, maxScrollY());
    const target = { scrollX: targetX, scrollY: targetY };
    window.scrollTo({ left: targetX, top: targetY, behavior: "instant" });

    let previous = currentScroll();
    let stableFrames = 0;
    for (let frame = 0; frame < SCROLL_SETTLE_FRAMES; frame += 1) {
      await nextAnimationFrame();
      const current = currentScroll();
      if (isNearScrollPosition(current, previous)) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }
      if (
        stableFrames >= SCROLL_STABLE_FRAMES &&
        isNearScrollPosition(current, target)
      ) {
        return { ok: true, ...current };
      }
      previous = current;
    }

    return {
      ok: false,
      ...previous,
    };
  }

  function pageDimensions() {
    return {
      totalHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
      ),
      totalWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
      scrollY: window.scrollY,
    };
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Cancelling from the page flips the selection's capture flag at once, long
  // before the background learns of it, so that flag is the abort signal.
  function captureAborted() {
    return !window.LassoSelection.isCaptureActive();
  }

  // Nothing scrolls during a one-pass render, so lazy content has to be asked
  // for first: walk the page one viewport at a time, then let images decode.
  async function preloadPage() {
    const scrollDeadline = performance.now() + PRELOAD_SCROLL_BUDGET_MS;
    const step = Math.max(1, window.innerHeight);

    for (
      let y = step;
      y <= maxScrollY() && performance.now() < scrollDeadline;
      y += step
    ) {
      if (captureAborted()) return pageDimensions();
      window.scrollTo({ left: window.scrollX, top: y, behavior: "instant" });
      await nextAnimationFrame();
      await nextAnimationFrame();
    }

    const pending = Array.from(document.images)
      .filter((img) => !img.complete)
      .map((img) => img.decode().catch(() => {}));
    const fonts = document.fonts?.ready ?? Promise.resolve();
    await Promise.race([
      Promise.all([...pending, fonts.catch(() => {})]),
      wait(PRELOAD_DECODE_BUDGET_MS),
    ]);

    await scrollToPosition({ y: 0 });
    return pageDimensions();
  }

  window.LassoCapture.init({
    isCaptureActive: () => window.LassoSelection.isCaptureActive(),
    onCaptureComplete: (options = {}) => {
      if (options.keepUi) {
        window.LassoSelection.markCaptureInactive();
        return;
      }
      if (options.finalize) {
        window.LassoSelection.cleanupSelection(options);
      }
    },
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case LassoMsg.GET_PAGE_DIMENSIONS:
        sendResponse(pageDimensions());
        break;

      case LassoMsg.SCROLL_TO:
        scrollToPosition(msg)
          .then(sendResponse)
          .catch(() => sendResponse({ ok: false }));
        return true;

      case LassoMsg.START_SELECTION:
        window.LassoSelection.startCaptureUI({ mode: msg.mode });
        sendResponse({ ok: true });
        break;

      case LassoMsg.START_PREVIEW:
        window.LassoSelection.startCaptureUI({ mode: "pick", preview: true });
        sendResponse({ ok: true });
        break;

      case LassoMsg.PREPARE_CAPTURE:
        window.LassoSelection.prepareCaptureChrome()
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
        return true;

      case LassoMsg.GET_CAPTURE_PARAMS:
        window.LassoSelection.getCaptureParams()
          .then(sendResponse)
          .catch(() => sendResponse(null));
        return true;

      case LassoMsg.CROP:
        window.LassoCapture.handleCropResult(msg)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => {
            console.error("Lasso crop failed:", err);
            sendResponse({ ok: false });
          });
        return true;

      case LassoMsg.STITCH_BEGIN:
        window.LassoCapture.beginStitch(msg)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err?.message }));
        return true;

      case LassoMsg.STITCH_SLICE:
        window.LassoCapture.addStitchSlice(msg)
          .then((result) => sendResponse({ ok: true, full: !!result.full }))
          .catch((err) => sendResponse({ ok: false, error: err?.message }));
        return true;

      case LassoMsg.STITCH_FINALIZE:
        window.LassoCapture.finalizeStitch()
          .then(() => sendResponse({ ok: true }))
          .catch((err) => {
            console.error("Lasso stitch failed:", err);
            sendResponse({ ok: false, error: err?.message });
          });
        return true;

      case LassoMsg.PIN_FIXED_ELEMENTS:
        window.LassoFixed.pinFixedElements()
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
        return true;

      case LassoMsg.PRELOAD_PAGE:
        preloadPage()
          .then(sendResponse)
          .catch(() => sendResponse(null));
        return true;

      case LassoMsg.VIEWPORT_SNAPSHOT:
        sendResponse({
          ok: true,
          ...window.LassoFixed.snapshotViewportSized(),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
        break;

      case LassoMsg.FREEZE_VIEWPORT_SIZED:
        sendResponse({
          ok: true,
          ...window.LassoFixed.freezeViewportSized(msg.delta),
        });
        break;

      case LassoMsg.RELEASE_FIXED_ELEMENTS:
        window.LassoFixed.releaseFixedElements();
        sendResponse({ ok: true });
        break;

      case LassoMsg.REVOKE_BLOB_URL:
        if (typeof msg.url === "string" && msg.url.startsWith("blob:")) {
          URL.revokeObjectURL(msg.url);
        }
        sendResponse({ ok: true });
        break;

      case LassoMsg.CAPTURE_CANCELLED:
        window.LassoCapture.abandonStitch();
        window.LassoSelection.onCaptureCancelled();
        sendResponse({ ok: true });
        break;

      case LassoMsg.CAPTURE_FAILED:
        window.LassoCapture.abandonStitch();
        window.LassoSelection.onCaptureFailed(msg.message);
        sendResponse({ ok: true });
        break;

      default:
        console.warn("Lasso: unknown message type:", msg.type);
        break;
    }
    return false;
  });
})();
