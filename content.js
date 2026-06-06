(() => {
  if (window.__lassoLoaded) return;
  window.__lassoLoaded = true;

  let selectionActive = false;
  let captureInProgress = false;
  let hiddenFixed = [];

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "getPageDimensions":
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

      case "scrollTo":
        window.scrollTo(0, msg.y);
        sendResponse({ ok: true });
        break;

      case "startSelection":
        startSelectionMode(msg.mode, msg.hideFixed);
        sendResponse({ ok: true });
        break;

      case "startPreview":
        startPreviewMode(msg.hideFixed);
        sendResponse({ ok: true });
        break;

      case "prepareCapture":
        hideCaptureChrome();
        sendResponse({ ok: true });
        break;

      case "getCaptureParams":
        sendResponse(getCaptureParams());
        break;

      case "crop":
        handleCropResult(msg).then(() => sendResponse({ ok: true }));
        return true;

      case "stitch":
        stitchAndExport(msg).then(() => sendResponse({ ok: true }));
        return true;

      case "hideFixedElements":
        hideFixedElements();
        sendResponse({ ok: true });
        break;

      case "restoreFixedElements":
        restoreFixedElements();
        sendResponse({ ok: true });
        break;

      case "captureCancelled":
        captureInProgress = false;
        restoreFixedElements();
        cleanupSelection();
        sendResponse({ ok: true });
        break;
    }
    return false;
  });

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
        type: "download",
        url,
        filename: "screenshot.png",
        revoke: true,
      });
    }
  }

  async function handleCropResult({ dataURL, rect, devicePixelRatio, action }) {
    if (!captureInProgress) return;
    captureInProgress = false;

    const blob = await cropDataUrl(dataURL, rect, devicePixelRatio);
    await exportBlob(blob, action);
    cleanupSelection();
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
  }) {
    if (!captureInProgress) return;
    captureInProgress = false;

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
    cleanupSelection();
  }

  function hideFixedElements() {
    restoreFixedElements();
    document.querySelectorAll("*").forEach((el) => {
      const style = getComputedStyle(el);
      if (style.position === "fixed" || style.position === "sticky") {
        hiddenFixed.push({ el, visibility: el.style.visibility });
        el.style.visibility = "hidden";
      }
    });
  }

  function restoreFixedElements() {
    hiddenFixed.forEach(({ el, visibility }) => {
      el.style.visibility = visibility;
    });
    hiddenFixed = [];
  }

  // --- Selection UI (pick / visible / fullpage) ---

  let overlay = null;
  let selection = null;
  let dimensions = null;
  let toolbar = null;
  let hint = null;
  let previewScreen = null;
  let freestyleOnly = false;
  let selectionMode = "idle";
  let selectionHideFixed = false;
  let selectionPhase = "idle";
  let lockedRect = null;
  let captureScrollY = 0;
  let userResized = false;
  let hoveredPickTarget = null;
  let pendingDraw = null;
  let drawActive = false;
  let suppressNextClick = false;
  const PICK_SCROLL_WAIT_MS = 200;
  const MIN_SELECTION_SIZE = 12;
  const DRAW_THRESHOLD = 4;
  const HANDLE_DIRS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const HANDLE_CURSORS = {
    nw: "nw-resize",
    n: "n-resize",
    ne: "ne-resize",
    e: "e-resize",
    se: "se-resize",
    s: "s-resize",
    sw: "sw-resize",
    w: "w-resize",
  };

  function setOverlayDim(active) {
    overlay?.classList.toggle("lasso-overlay-dim", active);
  }

  function rectFromDrag(x1, y1, x2, y2) {
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }

  function bindHoverListeners() {
    document.addEventListener("mousemove", onHoverMove, true);
    document.addEventListener("mousedown", onDrawMouseDown, true);
    document.addEventListener("mouseup", onDrawMouseUp, true);
    document.addEventListener("click", onHoverClick, true);
  }

  function unbindHoverListeners() {
    document.removeEventListener("mousemove", onHoverMove, true);
    document.removeEventListener("mousedown", onDrawMouseDown, true);
    document.removeEventListener("mouseup", onDrawMouseUp, true);
    document.removeEventListener("click", onHoverClick, true);
    pendingDraw = null;
    drawActive = false;
    suppressNextClick = false;
  }

  function bindFreezeListeners() {
    document.addEventListener("wheel", onFreezeEvent, {
      capture: true,
      passive: false,
    });
    document.addEventListener("touchmove", onFreezeEvent, {
      capture: true,
      passive: false,
    });
  }

  function unbindFreezeListeners() {
    document.removeEventListener("wheel", onFreezeEvent, true);
    document.removeEventListener("touchmove", onFreezeEvent, true);
  }

  function onFreezeEvent(e) {
    if (!selectionActive) return;
    if (isLassoChrome(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function startPreviewMode(hideFixed) {
    if (selectionActive) cleanupSelection();
    selectionActive = true;
    selectionMode = "pick";
    selectionHideFixed = !!hideFixed;
    selectionPhase = "hover";
    lockedRect = null;
    buildSelectionChrome();
    setOverlayDim(true);
    buildPreviewScreen();
    if (hint) hint.style.display = "none";
    bindHoverListeners();
  }

  function buildPreviewScreen() {
    previewScreen = document.createElement("div");
    previewScreen.id = "lasso-preview-screen";
    previewScreen.innerHTML = `
      <div class="lasso-preview-actions">
        <button type="button" class="lasso-preview-action" data-mode="visible">
          <span class="lasso-preview-action-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="5" width="18" height="14" rx="2"/>
              <path d="M7 9h10"/>
            </svg>
          </span>
          <span class="lasso-preview-action-copy">
            <span class="lasso-preview-action-title">Save visible</span>
            <span class="lasso-preview-action-desc">Current viewport</span>
          </span>
        </button>
        <button type="button" class="lasso-preview-action" data-mode="fullpage">
          <span class="lasso-preview-action-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="4" y="3" width="16" height="18" rx="2"/>
              <path d="M8 7h8M8 11h8M8 15h5"/>
            </svg>
          </span>
          <span class="lasso-preview-action-copy">
            <span class="lasso-preview-action-title">Save full page</span>
            <span class="lasso-preview-action-desc">Scroll and stitch</span>
          </span>
        </button>
      </div>
      <div class="lasso-preview-center">
        <div class="lasso-preview-mark" aria-hidden="true">
          <img src="${chrome.runtime.getURL("icons/icon48.png")}" width="56" height="56" alt="" />
        </div>
        <p class="lasso-preview-text">Drag a region, or hover an element and click. Esc cancels.</p>
        <button type="button" class="lasso-preview-cancel" data-action="cancel">Cancel</button>
      </div>
    `;
    previewScreen.addEventListener("click", onPreviewClick);
    document.body.append(previewScreen);
  }

  function onPreviewClick(e) {
    const actionBtn = e.target.closest("[data-action='cancel']");
    if (actionBtn) {
      e.preventDefault();
      e.stopPropagation();
      cancelOperation();
      return;
    }

    const modeBtn = e.target.closest(".lasso-preview-action[data-mode]");
    if (!modeBtn) return;

    e.preventDefault();
    e.stopPropagation();
    enterQuickCaptureMode(modeBtn.dataset.mode);
  }

  function enterQuickCaptureMode(mode) {
    removePreviewScreen();
    selectionMode = mode;
    selectionPhase = "locked";
    unbindHoverListeners();
    hint?.remove();
    hint = null;
    selection.style.display = "none";
    setOverlayDim(false);
    lockSelection(viewportRect());
  }

  function removePreviewScreen() {
    previewScreen?.remove();
    previewScreen = null;
  }

  function startSelectionMode(mode, hideFixed) {
    if (selectionActive) cleanupSelection();
    selectionActive = true;
    freestyleOnly = mode === "freestyle";
    selectionMode = freestyleOnly ? "pick" : mode;
    selectionHideFixed = hideFixed;
    lockedRect = null;
    buildSelectionChrome();

    if (freestyleOnly) {
      selectionPhase = "hover";
      setOverlayDim(true);
      hint.textContent = "Drag to select a region · Esc to cancel";
      bindHoverListeners();
      return;
    }

    if (mode === "pick") {
      selectionPhase = "hover";
      setOverlayDim(true);
      hint.textContent = "Hover an element · click to select · Esc to cancel";
      bindHoverListeners();
      return;
    }

    selectionPhase = "locked";
    hint.textContent =
      mode === "visible"
        ? "Adjust region · Esc to cancel"
        : "Full page · adjust crop or keep viewport · Esc to cancel";
    lockSelection(viewportRect());
  }

  function viewportRect() {
    return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function buildSelectionChrome() {
    overlay = document.createElement("div");
    overlay.id = "lasso-overlay";

    hint = document.createElement("div");
    hint.id = "lasso-hint";

    selection = document.createElement("div");
    selection.id = "lasso-selection";
    selection.className = "lasso-hover";
    selection.style.display = "none";

    dimensions = document.createElement("div");
    dimensions.id = "lasso-dimensions";
    selection.appendChild(dimensions);

    HANDLE_DIRS.forEach((dir) => {
      const handle = document.createElement("div");
      handle.className = "lasso-handle";
      handle.dataset.dir = dir;
      handle.style.cursor = HANDLE_CURSORS[dir];
      handle.style.display = "none";
      handle.addEventListener("mousedown", (e) => startResize(e, dir));
      selection.appendChild(handle);
    });

    toolbar = document.createElement("div");
    toolbar.id = "lasso-toolbar";
    toolbar.innerHTML = `
      <button type="button" class="lasso-btn-close" data-action="close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
      <span class="lasso-toolbar-divider" aria-hidden="true"></span>
      <button type="button" class="lasso-btn-copy" data-action="copy" aria-label="Copy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy
      </button>
      <button type="button" class="lasso-btn-download" data-action="download" aria-label="Download">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download
      </button>
    `;
    toolbar.addEventListener("click", onToolbarClick);
    selection.appendChild(toolbar);

    document.body.append(overlay, selection, hint);
    document.addEventListener("keydown", onSelectionKeyDown, true);
    bindFreezeListeners();
  }

  function onSelectionKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelOperation();
      return;
    }

    if (selectionPhase !== "locked") return;

    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    if (e.key.toLowerCase() === "c") {
      e.preventDefault();
      e.stopPropagation();
      executeCapture("copy");
      return;
    }

    if (e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      executeCapture("download");
    }
  }

  const INLINE_TAGS = /^(SPAN|A|TIME|LABEL|B|I|EM|STRONG|CODE|SMALL)$/i;

  function isLayoutShell(rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tall = rect.height >= vh * 0.88;
    const wide = rect.width >= vw * 0.35;
    const pageWide = rect.width >= vw * 0.9;
    return (tall && wide) || (pageWide && rect.height >= vh * 0.5);
  }

  function shouldPromotePickTarget(el) {
    const rect = el.getBoundingClientRect();
    const tiny = rect.width < 28 || rect.height < 20;
    return tiny && INLINE_TAGS.test(el.tagName);
  }

  function elementsUnderPoint(x, y) {
    if (!overlay) return document.elementsFromPoint(x, y);
    overlay.style.pointerEvents = "none";
    const stack = document.elementsFromPoint(x, y);
    overlay.style.pointerEvents = "auto";
    return stack;
  }

  function resolvePickTarget(x, y) {
    const stack = elementsUnderPoint(x, y).filter((el) => isPageEl(el));
    if (!stack.length) return null;

    for (const el of stack) {
      if (el.matches("img, video, picture, svg, canvas, [role='img']")) {
        return el;
      }
    }

    let candidate = null;
    for (const el of stack) {
      if (el === document.body || el === document.documentElement) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (isLayoutShell(rect)) continue;

      candidate = el;
      break;
    }

    if (!candidate) {
      candidate = stack.find(
        (el) => el !== document.body && el !== document.documentElement,
      );
    }
    if (!candidate) return null;

    for (let depth = 0; depth < 2; depth++) {
      if (!shouldPromotePickTarget(candidate)) break;

      const parent = candidate.parentElement;
      if (
        !parent ||
        parent === document.body ||
        parent === document.documentElement
      ) {
        break;
      }

      const parentRect = parent.getBoundingClientRect();
      if (isLayoutShell(parentRect)) break;

      candidate = parent;
    }

    return candidate;
  }

  function rectFromDomRect(rect) {
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  function getCaptureParams() {
    if (!lockedRect?.width || !lockedRect?.height) return null;

    const skipCrop = selectionMode === "fullpage" && !userResized;
    const params = {
      mode: selectionMode,
      devicePixelRatio: window.devicePixelRatio,
      skipCrop,
      rect: { ...lockedRect },
    };

    if (selectionMode === "fullpage" && userResized) {
      params.rect = {
        x: lockedRect.x,
        y: captureScrollY + lockedRect.y,
        width: lockedRect.width,
        height: lockedRect.height,
      };
    }

    return params;
  }

  function hideCaptureChrome() {
    overlay?.style.setProperty("visibility", "hidden", "important");
    selection?.style.setProperty("visibility", "hidden", "important");
    hint?.style.setProperty("visibility", "hidden", "important");
    previewScreen?.style.setProperty("visibility", "hidden", "important");
  }

  function canFreestyleDraw() {
    return !!previewScreen || freestyleOnly;
  }

  function onDrawMouseDown(e) {
    if (!selectionActive || !canFreestyleDraw() || selectionPhase !== "hover")
      return;
    if (isLassoChrome(e.target) || e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    hoveredPickTarget = null;
    selection.style.display = "none";
    pendingDraw = { x: e.clientX, y: e.clientY };
    drawActive = false;
  }

  function onDrawMouseUp(e) {
    if (!selectionActive || !canFreestyleDraw() || !pendingDraw) return;
    if (selectionPhase !== "hover") return;

    if (drawActive) {
      const rect = rectFromDrag(
        pendingDraw.x,
        pendingDraw.y,
        e.clientX,
        e.clientY,
      );
      pendingDraw = null;
      drawActive = false;
      suppressNextClick = true;

      if (
        rect.width >= MIN_SELECTION_SIZE &&
        rect.height >= MIN_SELECTION_SIZE
      ) {
        lockSelection(normalizeRect(rect));
        return;
      }

      selection.style.display = "none";
      setOverlayDim(true);
      return;
    }

    pendingDraw = null;
  }

  function onHoverMove(e) {
    if (!selectionActive || selectionPhase !== "hover") return;

    if (pendingDraw && canFreestyleDraw()) {
      const dx = e.clientX - pendingDraw.x;
      const dy = e.clientY - pendingDraw.y;
      if (!drawActive && Math.hypot(dx, dy) >= DRAW_THRESHOLD) {
        drawActive = true;
        hoveredPickTarget = null;
        setOverlayDim(false);
      }
      if (drawActive) {
        renderSelection(
          normalizeRect(
            rectFromDrag(pendingDraw.x, pendingDraw.y, e.clientX, e.clientY),
          ),
          "hover",
        );
        return;
      }
    }

    if (drawActive || pendingDraw || freestyleOnly) return;
    if (isLassoChrome(e.target)) {
      hoveredPickTarget = null;
      selection.style.display = "none";
      setOverlayDim(!!previewScreen || freestyleOnly);
      return;
    }

    const el = resolvePickTarget(e.clientX, e.clientY);
    hoveredPickTarget = el;
    if (!el) {
      selection.style.display = "none";
      setOverlayDim(!!previewScreen || freestyleOnly);
      return;
    }

    setOverlayDim(false);
    renderSelection(rectFromDomRect(el.getBoundingClientRect()), "hover");
  }

  async function onHoverClick(e) {
    if (!selectionActive || freestyleOnly) return;
    if (isLassoChrome(e.target)) return;

    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }

    if (selectionPhase !== "hover" || pendingDraw || drawActive) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = hoveredPickTarget || resolvePickTarget(e.clientX, e.clientY);
    if (!el) return;

    const domRect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const outOfView =
      domRect.top < 0 ||
      domRect.left < 0 ||
      domRect.bottom > vh ||
      domRect.right > vw;

    if (outOfView) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      await new Promise((r) => setTimeout(r, PICK_SCROLL_WAIT_MS));
    }

    lockSelection(rectFromDomRect(el.getBoundingClientRect()));
  }

  function lockSelection(rect) {
    selectionPhase = "locked";
    userResized = false;
    lockedRect = normalizeRect(rect);
    pendingDraw = null;
    drawActive = false;
    suppressNextClick = false;
    removePreviewScreen();
    hint?.remove();
    hint = null;

    selection.className = "lasso-locked";
    selection.querySelectorAll(".lasso-handle").forEach((h) => {
      h.style.display = "block";
    });

    unbindHoverListeners();

    renderSelection(lockedRect, "locked");
  }

  function normalizeRect(rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y, width, height } = rect;
    width = Math.max(MIN_SELECTION_SIZE, Math.min(width, vw));
    height = Math.max(MIN_SELECTION_SIZE, Math.min(height, vh));
    x = Math.max(0, Math.min(x, vw - width));
    y = Math.max(0, Math.min(y, vh - height));
    return { x, y, width, height };
  }

  function renderSelection(rect, phase) {
    if (rect.width <= 0 || rect.height <= 0) {
      selection.style.display = "none";
      return;
    }

    selection.style.display = "block";
    selection.style.top = rect.y + "px";
    selection.style.left = rect.x + "px";
    selection.style.width = rect.width + "px";
    selection.style.height = rect.height + "px";

    dimensions.textContent =
      Math.round(rect.width) + " \u00d7 " + Math.round(rect.height);
    dimensions.style.display = phase === "locked" ? "block" : "none";

    if (phase === "locked") {
      positionHandles(rect);
      positionToolbar(rect);
    }
  }

  function positionHandles(rect) {
    const { width, height } = rect;
    const positions = {
      nw: [0, 0],
      n: [width / 2, 0],
      ne: [width, 0],
      e: [width, height / 2],
      se: [width, height],
      s: [width / 2, height],
      sw: [0, height],
      w: [0, height / 2],
    };

    selection.querySelectorAll(".lasso-handle").forEach((handle) => {
      const [left, top] = positions[handle.dataset.dir];
      handle.style.left = left + "px";
      handle.style.top = top + "px";
    });
  }

  function positionToolbar(rect) {
    if (selectionMode === "visible" || selectionMode === "fullpage") {
      toolbar.classList.add("lasso-toolbar-fixed");
      toolbar.style.left = "";
      toolbar.style.top = "";
      return;
    }

    toolbar.classList.remove("lasso-toolbar-fixed");
    const gap = 8;
    toolbar.style.left = Math.max(0, rect.width - 300) + "px";
    toolbar.style.top = rect.height + gap + "px";
  }

  function startResize(e, dir) {
    if (selectionPhase !== "locked" || !lockedRect) return;

    e.preventDefault();
    e.stopPropagation();
    selection.classList.add("lasso-resizing");

    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...lockedRect };

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let { x, y, width, height } = start;

      if (dir.includes("e")) width = start.width + dx;
      if (dir.includes("w")) {
        x = start.x + dx;
        width = start.width - dx;
      }
      if (dir.includes("s")) height = start.height + dy;
      if (dir.includes("n")) {
        y = start.y + dy;
        height = start.height - dy;
      }

      userResized = true;
      lockedRect = normalizeRect({ x, y, width, height });
      renderSelection(lockedRect, "locked");
    }

    function onUp() {
      selection.classList.remove("lasso-resizing");
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    }

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  }

  function onToolbarClick(e) {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    const action = btn.dataset.action;
    if (action === "close") {
      cancelOperation();
      return;
    }

    if (action === "copy" || action === "download") {
      executeCapture(action);
    }
  }

  function executeCapture(action) {
    if (!lockedRect) return;

    captureInProgress = true;
    captureScrollY = window.scrollY;
    hideCaptureChrome();

    chrome.runtime.sendMessage({
      type: "selectionCapture",
      mode: selectionMode,
      hideFixed: selectionHideFixed,
      action,
    });
  }

  function cancelOperation() {
    if (!selectionActive && !captureInProgress) return;

    captureInProgress = false;
    chrome.runtime.sendMessage({ type: "cancelCapture" });
    restoreFixedElements();
    cleanupSelection();
  }

  function isLassoChrome(el) {
    return !!el?.closest?.(
      ".lasso-handle, #lasso-toolbar, #lasso-preview-screen, .lasso-preview-action, .lasso-preview-cancel",
    );
  }

  function isPageEl(el) {
    return (
      !!el &&
      !el.closest?.(
        "#lasso-overlay, #lasso-selection, #lasso-hint, #lasso-preview-screen",
      )
    );
  }

  function cleanupSelection() {
    captureInProgress = false;
    selectionActive = false;
    selectionPhase = "idle";
    selectionMode = "idle";
    freestyleOnly = false;
    lockedRect = null;
    captureScrollY = 0;
    userResized = false;
    hoveredPickTarget = null;
    pendingDraw = null;
    drawActive = false;
    suppressNextClick = false;
    overlay?.remove();
    selection?.remove();
    hint?.remove();
    removePreviewScreen();
    overlay = selection = dimensions = toolbar = hint = null;
    unbindHoverListeners();
    unbindFreezeListeners();
    document.removeEventListener("keydown", onSelectionKeyDown, true);
  }
})();
