(() => {
  if (window.__lassoGeometryLoaded) return;
  window.__lassoGeometryLoaded = true;

  const MAX_CANVAS_DIM = 32767;
  const MAX_CANVAS_AREA = 268435456; // 16384 * 16384, Chrome's safe canvas area

  // Pages that lazy-load on scroll grow while the capture runs, and the stitch
  // canvas cannot be resized once allocated. Overshoot the first measurement so
  // late content still has somewhere to land.
  const GROWTH_FACTOR = 1.25;
  const MAX_EXTRA_VIEWPORTS = 8;

  // A fixed element covering most of the viewport is a scrim or a modal
  // backdrop. Pinning one would tint a viewport-tall band of the output.
  const OVERLAY_COVERAGE = 0.85;

  // How close to the bottom edge counts as "floating widget", as a share of
  // viewport height. Covers the usual 16-32px offsets without catching content.
  const BOTTOM_ANCHOR_RATIO = 0.06;

  function plannedCanvasHeight(measuredHeight, viewportHeight) {
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
      return measuredHeight;
    }

    const allowance = Math.min(
      measuredHeight * (GROWTH_FACTOR - 1),
      viewportHeight * MAX_EXTRA_VIEWPORTS,
    );
    return Math.round(measuredHeight + allowance);
  }

  // Sizes the stitch canvas from the first slice. Allocation covers the growth
  // allowance so lazy-loaded content still lands. Truncation is reported at
  // finalize by comparing what was drawn against the page height, so the canvas
  // only has to say how tall it can be.
  //
  // A one-pass render knows the full height up front and nothing scrolls, so it
  // passes `fixedHeight` to skip the growth allowance.
  function stitchCanvasFor(
    measuredHeight,
    viewportHeight,
    dpr,
    width,
    { fixedHeight = false } = {},
  ) {
    const maxHeight = Math.min(
      MAX_CANVAS_DIM,
      Math.floor(MAX_CANVAS_AREA / width),
    );
    const planned = fixedHeight
      ? measuredHeight
      : plannedCanvasHeight(measuredHeight, viewportHeight);

    return Math.min(Math.round(planned * dpr), maxHeight);
  }

  // The smallest CSS length whose device-pixel size is a whole number, so chunk
  // edges land on pixel boundaries and adjacent chunks cannot leave a seam.
  function wholePixelUnit(dpr) {
    for (let unit = 1; unit <= 100; unit += 1) {
      const device = dpr * unit;
      if (Math.abs(device - Math.round(device)) < 1e-6) return unit;
    }
    return 1;
  }

  // Splits a document into clips for `Page.captureScreenshot`. A single capture
  // taller than the GPU texture limit repeats its content, so each chunk stays
  // under `maxDevicePx`. Every `y` and `height` is a whole number of device
  // pixels. The last chunk is rounded up to the same grid; the stitch trims it
  // back to the real page height. `width` (CSS px) applies the stitch canvas
  // limits to the total.
  function screenshotChunks(contentHeight, dpr, maxDevicePx = 8192, width) {
    if (!(contentHeight > 0) || !(dpr > 0)) return [];

    const unit = wholePixelUnit(dpr);
    const chunkHeight = Math.max(
      unit,
      Math.floor(maxDevicePx / dpr / unit) * unit,
    );

    let total = contentHeight;
    if (width > 0) {
      const maxDeviceHeight = Math.min(
        MAX_CANVAS_DIM,
        Math.floor(MAX_CANVAS_AREA / Math.round(width * dpr)),
      );
      const maxCss = Math.floor(maxDeviceHeight / dpr / unit) * unit;
      total = Math.min(total, maxCss);
    }

    const chunks = [];
    for (let y = 0; y < total; y += chunkHeight) {
      const remaining = Math.ceil((total - y) / unit) * unit;
      chunks.push({ y, height: Math.min(chunkHeight, remaining) });
    }
    return chunks;
  }

  // Indices of elements whose height followed a viewport height change of
  // `delta`. Compares measurements taken before and after resizing the viewport.
  // An element sized `100vh` moves by the full delta, `50vh` by half; anything
  // that moved by more than the delta reflowed for another reason.
  function viewportSizedIndices(before, after, delta) {
    const indices = [];
    const count = Math.min(before.length, after.length);
    for (let i = 0; i < count; i += 1) {
      if (!Number.isFinite(before[i]) || !Number.isFinite(after[i])) continue;
      const change = Math.abs(after[i] - before[i]);
      if (change >= 1 && change <= Math.abs(delta) + 1) indices.push(i);
    }
    return indices;
  }

  function sliceGeometry(scrollY, viewportHeight, totalHeight, dpr) {
    const sliceHeight = Math.min(viewportHeight, totalHeight - scrollY);
    return {
      destY: Math.round(scrollY * dpr),
      srcHeight: Math.round(sliceHeight * dpr),
    };
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

  function absoluteOffsetFor(targetDocRect, containerDocRect, containerBorder) {
    if (!containerDocRect) {
      return { top: targetDocRect.y, left: targetDocRect.x };
    }

    return {
      top: targetDocRect.y - (containerDocRect.y + containerBorder.top),
      left: targetDocRect.x - (containerDocRect.x + containerBorder.left),
    };
  }

  // Decides what a stuck element should become during a full-page capture.
  //
  //   "release" — a sticky element is already in flow; dropping it to static
  //               leaves it at its natural position, no coordinates needed.
  //   "pin"     — a fixed element is out of flow, so it needs an absolute
  //               position at the document coordinates it occupies now.
  //   "hide"    — scrims and floating widgets have no honest document position;
  //               pinning one drops it mid-page and reads as a bug.
  //
  // `seenScrolled` marks a fixed element first seen after the page scrolled. It
  // cannot be pinned honestly: its current position is relative to a scroll
  // offset that no slice shares, so pinning lands it partway down the page.
  function treatmentFor(
    position,
    rect,
    viewportWidth,
    viewportHeight,
    { seenScrolled = false } = {},
  ) {
    if (position === "sticky") return "release";
    if (seenScrolled) return "hide";
    if (!rect || viewportWidth <= 0 || viewportHeight <= 0) return "pin";

    const coversViewport =
      rect.width >= viewportWidth * OVERLAY_COVERAGE &&
      rect.height >= viewportHeight * OVERLAY_COVERAGE;
    if (coversViewport) return "hide";

    // Chat bubbles, cookie bars and back-to-top buttons sit near the bottom
    // edge, usually with a small margin.
    const bottomGap = viewportHeight - (rect.y + rect.height);
    const anchoredToBottom =
      bottomGap <= viewportHeight * BOTTOM_ANCHOR_RATIO &&
      rect.y > viewportHeight / 2;
    if (anchoredToBottom) return "hide";

    return "pin";
  }

  // Properties that make an ancestor the containing block of a fixed or
  // absolutely positioned descendant. Pinning resolves offsets against this
  // ancestor, so missing one puts the element at the wrong origin.
  // `contain: content` and `strict` both imply layout and paint containment.
  function establishesContainingBlock(style) {
    if (!style) return false;
    if (style.position && style.position !== "static") return true;
    if (style.transform && style.transform !== "none") return true;
    if (style.filter && style.filter !== "none") return true;
    if (style.perspective && style.perspective !== "none") return true;
    if (style.backdropFilter && style.backdropFilter !== "none") return true;
    if (style.containerType && style.containerType !== "normal") return true;
    if (/\b(layout|paint|strict|content)\b/.test(style.contain || "")) {
      return true;
    }
    return /\b(transform|filter|perspective)\b/.test(style.willChange || "");
  }

  function resizeRect(start, dir, dx, dy, options = {}) {
    const minSize = options.minSize || 1;
    const centered = !!options.centered;
    const preserveAspect = !!options.preserveAspect;
    const bounds = options.bounds || {
      width: Number.POSITIVE_INFINITY,
      height: Number.POSITIVE_INFINITY,
    };
    const ratio = start.width / start.height;
    const xDirection = dir.includes("w") ? -1 : dir.includes("e") ? 1 : 0;
    const yDirection = dir.includes("n") ? -1 : dir.includes("s") ? 1 : 0;
    const deltaScale = centered ? 2 : 1;
    const anchorX = centered || !xDirection
      ? start.x + start.width / 2
      : xDirection > 0
        ? start.x
        : start.x + start.width;
    const anchorY = centered || !yDirection
      ? start.y + start.height / 2
      : yDirection > 0
        ? start.y
        : start.y + start.height;

    const maxWidth = centered || !xDirection
      ? 2 * Math.min(anchorX, bounds.width - anchorX)
      : xDirection > 0
        ? bounds.width - anchorX
        : anchorX;
    const maxHeight = centered || !yDirection
      ? 2 * Math.min(anchorY, bounds.height - anchorY)
      : yDirection > 0
        ? bounds.height - anchorY
        : anchorY;

    let width = start.width + xDirection * dx * deltaScale;
    let height = start.height + yDirection * dy * deltaScale;

    if (preserveAspect) {
      const xScale = xDirection
        ? 1 + (xDirection * dx * deltaScale) / start.width
        : null;
      const yScale = yDirection
        ? 1 + (yDirection * dy * deltaScale) / start.height
        : null;
      let scale;
      if (xScale != null && yScale != null) {
        scale = Math.abs(xScale - 1) >= Math.abs(yScale - 1)
          ? xScale
          : yScale;
      } else {
        scale = xScale ?? yScale ?? 1;
      }

      const minScale = Math.max(minSize / start.width, minSize / start.height);
      const maxScale = Math.min(maxWidth / start.width, maxHeight / start.height);
      scale = Math.max(minScale, Math.min(scale, maxScale));
      width = start.width * scale;
      height = start.height * scale;
    } else {
      width = xDirection
        ? Math.max(minSize, Math.min(width, maxWidth))
        : start.width;
      height = yDirection
        ? Math.max(minSize, Math.min(height, maxHeight))
        : start.height;
    }

    const x = centered || !xDirection
      ? anchorX - width / 2
      : xDirection > 0
        ? anchorX
        : anchorX - width;
    const y = centered || !yDirection
      ? anchorY - height / 2
      : yDirection > 0
        ? anchorY
        : anchorY - height;

    return { x, y, width, height };
  }

  window.LassoGeometry = {
    stitchCanvasFor,
    screenshotChunks,
    viewportSizedIndices,
    sliceGeometry,
    cropRectForStitch,
    absoluteOffsetFor,
    treatmentFor,
    establishesContainingBlock,
    resizeRect,
  };
})();
