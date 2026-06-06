(() => {
  if (window.__lassoLoaded) return;
  window.__lassoLoaded = true;

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
        window.scrollTo(0, msg.y);
        sendResponse({ ok: true });
        break;

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
        window.LassoSelection.hideCaptureChrome();
        sendResponse({ ok: true });
        break;

      case LassoMsg.GET_CAPTURE_PARAMS:
        sendResponse(window.LassoSelection.getCaptureParams());
        break;

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
