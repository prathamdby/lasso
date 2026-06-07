(() => {
  if (window.__lassoLoaded) return;
  window.__lassoLoaded = true;

  const SCROLL_SETTLE_FRAMES = 4;
  const SCROLL_EPSILON = 1;

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

  function isNearScrollTarget(x, y) {
    return (
      Math.abs(window.scrollX - x) <= SCROLL_EPSILON &&
      Math.abs(window.scrollY - y) <= SCROLL_EPSILON
    );
  }

  async function scrollToPosition({ x = window.scrollX, y = window.scrollY }) {
    const targetX = clamp(x, 0, maxScrollX());
    const targetY = clamp(y, 0, maxScrollY());
    window.scrollTo({ left: targetX, top: targetY, behavior: "instant" });

    for (let frame = 0; frame < SCROLL_SETTLE_FRAMES; frame += 1) {
      await nextAnimationFrame();
      if (isNearScrollTarget(targetX, targetY)) {
        return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY };
      }
    }

    return {
      ok: isNearScrollTarget(targetX, targetY),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
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
        sendResponse({
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
        });
        break;

      case LassoMsg.SCROLL_TO:
        scrollToPosition(msg)
          .then(sendResponse)
          .catch(() => sendResponse({ ok: false }));
        return true;

      case LassoMsg.START_SELECTION:
        window.LassoSelection.startCaptureUI({
          mode: msg.mode,
          hideFixed: msg.hideFixed,
        });
        sendResponse({ ok: true });
        break;

      case LassoMsg.START_PREVIEW:
        window.LassoSelection.startCaptureUI({
          mode: "pick",
          hideFixed: msg.hideFixed,
          preview: true,
        });
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

      case LassoMsg.STITCH:
        window.LassoCapture.stitchAndExport(msg)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => {
            console.error("Lasso stitch failed:", err);
            sendResponse({ ok: false });
          });
        return true;

      case LassoMsg.HIDE_FIXED_ELEMENTS:
        window.LassoFixed.hideFixedElements();
        sendResponse({ ok: true });
        break;

      case LassoMsg.RESTORE_FIXED_ELEMENTS:
        window.LassoFixed.restoreFixedElements();
        sendResponse({ ok: true });
        break;

      case LassoMsg.CAPTURE_CANCELLED:
        window.LassoSelection.onCaptureCancelled();
        sendResponse({ ok: true });
        break;

      case LassoMsg.CAPTURE_FAILED:
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
