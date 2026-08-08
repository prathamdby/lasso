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
  function stitchCanvasFor(measuredHeight, viewportHeight, dpr, width) {
    const maxHeight = Math.min(
      MAX_CANVAS_DIM,
      Math.floor(MAX_CANVAS_AREA / width),
    );
    const planned = plannedCanvasHeight(measuredHeight, viewportHeight);

    return Math.min(Math.round(planned * dpr), maxHeight);
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
  function treatmentFor(position, rect, viewportWidth, viewportHeight) {
    if (position === "sticky") return "release";
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

  window.LassoGeometry = {
    stitchCanvasFor,
    sliceGeometry,
    cropRectForStitch,
    absoluteOffsetFor,
    treatmentFor,
    establishesContainingBlock,
  };
})();
