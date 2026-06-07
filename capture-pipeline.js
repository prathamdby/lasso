(() => {
  if (window.__lassoPipelineLoaded) return;
  window.__lassoPipelineLoaded = true;

  let isCaptureActive = () => false;
  let onCaptureComplete = () => {};

  const EXPORT_DEFAULTS = { format: "png", quality: 0.92 };
  const FORMAT_MIME = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  const FORMAT_EXT = { png: "png", jpeg: "jpg", webp: "webp" };

  function init(deps) {
    isCaptureActive = deps.isCaptureActive;
    onCaptureComplete = deps.onCaptureComplete;
  }

  async function getExportSettings() {
    try {
      const { lassoFormat } = await chrome.storage.local.get("lassoFormat");
      const format = FORMAT_MIME[lassoFormat]
        ? lassoFormat
        : EXPORT_DEFAULTS.format;
      return { format, quality: EXPORT_DEFAULTS.quality };
    } catch {
      return { ...EXPORT_DEFAULTS };
    }
  }

  // The async clipboard reliably accepts only PNG, so copies stay lossless
  // PNG; the chosen format and quality apply to downloads.
  function outputFor(action, settings) {
    if (action === "copy") {
      return { format: "png", mime: "image/png", quality: undefined };
    }
    const format = settings.format;
    return {
      format,
      mime: FORMAT_MIME[format],
      quality: format === "png" ? undefined : settings.quality,
    };
  }

  function loadImage(dataURL) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataURL;
    });
  }

  function fillJpegBackdrop(ctx, width, height, out) {
    // JPEG has no alpha channel, so transparent pixels render black. Paint a
    // white backdrop first so they come out white instead.
    if (out.mime !== "image/jpeg") return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }

  async function cropFromCanvas(source, rect, dpr, out) {
    const canvas = new OffscreenCanvas(
      Math.round(rect.width * dpr),
      Math.round(rect.height * dpr),
    );
    const ctx = canvas.getContext("2d");
    fillJpegBackdrop(ctx, canvas.width, canvas.height, out);
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
    return canvas.convertToBlob({ type: out.mime, quality: out.quality });
  }

  async function cropDataUrl(dataURL, rect, dpr, out) {
    const img = await loadImage(dataURL);
    return cropFromCanvas(img, rect, dpr, out);
  }

  async function exportBlob(blob, action, out) {
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
        filename: `screenshot.${FORMAT_EXT[out.format]}`,
        revoke: true,
      });
    }
  }

  async function handleCropResult({ dataURL, rect, devicePixelRatio, action }) {
    if (!isCaptureActive()) return;
    onCaptureComplete({ keepUi: true });

    try {
      const out = outputFor(action, await getExportSettings());
      const blob = await cropDataUrl(dataURL, rect, devicePixelRatio, out);
      await exportBlob(blob, action, out);
      onCaptureComplete({ finalize: true });
    } catch (err) {
      onCaptureComplete({
        finalize: true,
        error: err?.message || "Capture failed",
      });
    }
  }

  function stitchHeightFromCaptures(captures, totalHeight, viewportHeight) {
    if (!captures.length) return 0;
    const lastY = captures[captures.length - 1].y;
    return Math.min(
      totalHeight,
      lastY + Math.min(viewportHeight, totalHeight - lastY),
    );
  }

  function cropRectForStitch(exportRect, stitchHeight) {
    if (exportRect.y >= stitchHeight) {
      throw new Error("Crop region is below the captured page area");
    }

    if (exportRect.y + exportRect.height <= stitchHeight) {
      return exportRect;
    }

    return {
      ...exportRect,
      height: stitchHeight - exportRect.y,
    };
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
      const out = outputFor(action, await getExportSettings());
      const stitchHeight = stitchHeightFromCaptures(
        captures,
        totalHeight,
        viewportHeight,
      );
      if (stitchHeight <= 0) {
        throw new Error("No capture slices to stitch");
      }

      const canvas = document.createElement("canvas");
      canvas.width = totalWidth * dpr;
      canvas.height = stitchHeight * dpr;
      const ctx = canvas.getContext("2d");
      fillJpegBackdrop(ctx, canvas.width, canvas.height, out);

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
        blob = await cropFromCanvas(
          canvas,
          cropRectForStitch(exportRect, stitchHeight),
          dpr,
          out,
        );
      } else {
        blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, out.mime, out.quality),
        );
      }

      await exportBlob(blob, action, out);
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
