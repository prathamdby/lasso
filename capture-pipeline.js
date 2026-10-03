(() => {
  if (window.__lassoPipelineLoaded) return;
  window.__lassoPipelineLoaded = true;

  // Fails at injection with a precise message. Without it a misordered
  // content_scripts list surfaces as a ReferenceError mid-capture, which the
  // caller reports as a generic stitch failure.
  if (!window.LassoGeometry) {
    throw new Error("Lasso: geometry.js must load before capture-pipeline.js");
  }

  let isCaptureActive = () => false;
  let onCaptureComplete = () => {};

  const EXPORT_DEFAULTS = { format: "png", quality: 0.92 };
  const FORMAT_MIME = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  const FORMAT_EXT = { png: "png", jpeg: "jpg", webp: "webp" };
  let stitch = null;

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

  async function beginStitch({
    totalHeight,
    viewportHeight,
    sliceHeight,
    fixedHeight,
    devicePixelRatio,
    exportRect,
    skipCrop,
    action,
  }) {
    if (!isCaptureActive()) throw new Error("Capture is no longer active");
    onCaptureComplete({ keepUi: true });
    stitch = {
      totalHeight,
      viewportHeight,
      // One-pass renders slice by chunk, not by viewport.
      sliceHeight,
      fixedHeight: !!fixedHeight,
      dpr: devicePixelRatio,
      exportRect,
      skipCrop,
      action,
      out: outputFor(action, await getExportSettings()),
      canvas: null,
      ctx: null,
      drawnBottom: 0,
    };
  }

  async function addStitchSlice({ dataURL, y, pageHeight }) {
    if (!stitch) throw new Error("No stitch in progress");
    const img = await loadImage(dataURL);

    // Lazy-loading pages grow while the capture runs. Track the latest height so
    // the final slice is trimmed against the page as it is now, not as it was
    // when the loop started.
    stitch.totalHeight = Math.max(stitch.totalHeight, pageHeight || 0);

    if (!stitch.canvas) {
      const width = img.width;
      stitch.canvas = document.createElement("canvas");
      stitch.canvas.width = width;
      stitch.canvas.height = LassoGeometry.stitchCanvasFor(
        stitch.totalHeight,
        stitch.viewportHeight,
        stitch.dpr,
        width,
        { fixedHeight: stitch.fixedHeight },
      );
      stitch.ctx = stitch.canvas.getContext("2d");
      fillJpegBackdrop(
        stitch.ctx,
        stitch.canvas.width,
        stitch.canvas.height,
        stitch.out,
      );
    }

    const { destY, srcHeight } = LassoGeometry.sliceGeometry(
      y,
      stitch.sliceHeight ?? stitch.viewportHeight,
      stitch.totalHeight,
      stitch.dpr,
    );

    stitch.ctx.drawImage(
      img,
      0,
      0,
      img.width,
      srcHeight,
      0,
      destY,
      img.width,
      srcHeight,
    );

    stitch.drawnBottom = Math.min(
      stitch.canvas.height,
      Math.max(stitch.drawnBottom, destY + srcHeight),
    );

    return { full: destY + srcHeight >= stitch.canvas.height };
  }

  async function finalizeStitch() {
    if (!stitch) throw new Error("No stitch in progress");
    const session = stitch;
    stitch = null;

    try {
      if (!session.canvas || session.drawnBottom <= 0) {
        throw new Error("No capture slices to stitch");
      }

      const stitchHeightCss = session.drawnBottom / session.dpr;
      let blob;
      if (session.exportRect && !session.skipCrop) {
        blob = await cropFromCanvas(
          session.canvas,
          LassoGeometry.cropRectForStitch(session.exportRect, stitchHeightCss),
          session.dpr,
          session.out,
        );
      } else if (session.drawnBottom < session.canvas.height) {
        blob = await cropFromCanvas(
          session.canvas,
          {
            x: 0,
            y: 0,
            width: session.canvas.width / session.dpr,
            height: stitchHeightCss,
          },
          session.dpr,
          session.out,
        );
      } else {
        blob = await new Promise((resolve) =>
          session.canvas.toBlob(resolve, session.out.mime, session.out.quality),
        );
      }

      if (!blob) throw new Error("Could not encode the stitched image");

      await exportBlob(blob, session.action, session.out);
      // The canvas cannot grow once allocated, so a page that outgrew it stops
      // the run early. Compare what was drawn against the last known page
      // height rather than the scroll target, which advances past the page end.
      onCaptureComplete({
        finalize: true,
        truncated: stitchHeightCss < session.totalHeight - 1,
      });
    } catch (err) {
      onCaptureComplete({
        finalize: true,
        error: err?.message || "Capture failed",
      });
    }
  }

  function abandonStitch() {
    stitch = null;
  }

  window.LassoCapture = {
    init,
    handleCropResult,
    beginStitch,
    addStitchSlice,
    finalizeStitch,
    abandonStitch,
  };
})();
