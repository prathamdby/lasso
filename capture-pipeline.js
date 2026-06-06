(() => {
  if (window.__lassoPipelineLoaded) return;
  window.__lassoPipelineLoaded = true;

  let isCaptureActive = () => false;
  let onCaptureComplete = () => {};

  function init(deps) {
    isCaptureActive = deps.isCaptureActive;
    onCaptureComplete = deps.onCaptureComplete;
  }

  function loadImage(dataURL) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataURL;
    });
  }

  async function cropFromCanvas(source, rect, dpr) {
    const canvas = new OffscreenCanvas(
      Math.round(rect.width * dpr),
      Math.round(rect.height * dpr),
    );
    const ctx = canvas.getContext("2d");
    ctx.drawImage(
      source,
      rect.x * dpr,
      rect.y * dpr,
      rect.width * dpr,
      rect.height * dpr,
      0,
      0,
      rect.width * dpr,
      rect.height * dpr,
    );
    return canvas.convertToBlob({ type: "image/png" });
  }

  async function cropDataUrl(dataURL, rect, dpr) {
    const img = await loadImage(dataURL);
    return cropFromCanvas(img, rect, dpr);
  }

  async function exportBlob(blob, action) {
    if (action === "copy") {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      return;
    }

    if (action === "download") {
      const url = URL.createObjectURL(blob);
      chrome.runtime.sendMessage({
        type: LassoMsg.DOWNLOAD,
        url,
        filename: "screenshot.png",
        revoke: true,
      });
    }
  }

  async function handleCropResult({ dataURL, rect, devicePixelRatio, action }) {
    if (!isCaptureActive()) return;
    onCaptureComplete({ keepUi: true });

    try {
      const blob = await cropDataUrl(dataURL, rect, devicePixelRatio);
      await exportBlob(blob, action);
      onCaptureComplete({ finalize: true });
    } catch (err) {
      onCaptureComplete({
        finalize: true,
        error: err?.message || "Capture failed",
      });
    }
  }

  async function stitchAndExport({
    captures,
    totalWidth,
    totalHeight,
    viewportHeight,
    devicePixelRatio: dpr,
    exportRect,
    skipCrop,
    action,
    truncated,
  }) {
    if (!isCaptureActive()) return;
    onCaptureComplete({ keepUi: true });

    try {
      const canvas = document.createElement("canvas");
      canvas.width = totalWidth * dpr;
      canvas.height = totalHeight * dpr;
      const ctx = canvas.getContext("2d");

      for (const { dataURL, y } of captures) {
        const img = await loadImage(dataURL);
        const remainder = totalHeight - y;
        const sliceHeight = Math.min(viewportHeight, remainder);
        const srcHeight = sliceHeight * dpr;

        ctx.drawImage(
          img,
          0,
          0,
          img.width,
          srcHeight,
          0,
          y * dpr,
          totalWidth * dpr,
          sliceHeight * dpr,
        );
      }

      let blob;
      if (exportRect && !skipCrop) {
        blob = await cropFromCanvas(canvas, exportRect, dpr);
      } else {
        blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        );
      }

      await exportBlob(blob, action);
      onCaptureComplete({ finalize: true, truncated: !!truncated });
    } catch (err) {
      onCaptureComplete({
        finalize: true,
        error: err?.message || "Capture failed",
      });
    }
  }

  window.LassoCapture = { init, handleCropResult, stitchAndExport };
})();
