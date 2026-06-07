(() => {
  if (window.__lassoSelectionLoaded) return;
  window.__lassoSelectionLoaded = true;

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
  const INLINE_TAGS = /^(SPAN|A|TIME|LABEL|B|I|EM|STRONG|CODE|SMALL)$/i;

  const sel = {
    active: false,
    phase: "idle",
    mode: "idle",
    hideFixed: false,
    preview: false,
    rect: null,
    captureInProgress: false,
    captureScrollY: 0,
    userResized: false,
    hoverTarget: null,
    pickedItems: [],
    pickAnchorDocRect: null,
    pickManualDocRect: null,
    pickPreviewEl: null,
    pickAddInFlight: false,
    pickAddPromise: null,
    draw: { pending: null, active: false, suppressClick: false },
    dom: {
      overlay: null,
      selection: null,
      dimensions: null,
      toolbar: null,
      hint: null,
      previewScreen: null,
    },
  };

  function overlay() {
    return sel.dom.overlay;
  }

  function selectionEl() {
    return sel.dom.selection;
  }

  function hintEl() {
    return sel.dom.hint;
  }

  function previewScreenEl() {
    return sel.dom.previewScreen;
  }

  function canFreestyleDraw() {
    return sel.preview || sel.mode === "freestyle";
  }

  function setOverlayDim(active) {
    overlay()?.classList.toggle("lasso-overlay-dim", active);
  }

  function rectFromDrag(x1, y1, x2, y2) {
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }

  function rectForCapture(state) {
    if (!state.rect?.width || !state.rect?.height) return null;

    const skipCrop = state.mode === "fullpage" && !state.userResized;
    const params = {
      mode: state.mode,
      devicePixelRatio: window.devicePixelRatio,
      skipCrop,
      rect: { ...state.rect },
    };

    if (state.mode === "fullpage" && state.userResized) {
      params.rect = {
        x: state.rect.x,
        y: state.captureScrollY + state.rect.y,
        width: state.rect.width,
        height: state.rect.height,
      };
    }

    return params;
  }

  function bindHoverListeners() {
    document.addEventListener("mousemove", onHoverMove, true);
    document.addEventListener("mouseup", onDrawMouseUp, true);
    document.addEventListener("click", onHoverClick, true);
  }

  function unbindHoverListeners() {
    document.removeEventListener("mousemove", onHoverMove, true);
    document.removeEventListener("mouseup", onDrawMouseUp, true);
    document.removeEventListener("click", onHoverClick, true);
    sel.draw.pending = null;
    sel.draw.active = false;
    sel.draw.suppressClick = false;
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

  function bindSelectionGuardListeners() {
    document.addEventListener("selectstart", onSelectionGuardEvent, true);
    document.addEventListener("mousedown", onSelectionBlockMouseDown, true);
  }

  function unbindSelectionGuardListeners() {
    document.removeEventListener("selectstart", onSelectionGuardEvent, true);
    document.removeEventListener("mousedown", onSelectionBlockMouseDown, true);
  }

  function clearPageSelection() {
    window.getSelection()?.removeAllRanges();
  }

  function onSelectionGuardEvent(e) {
    if (!sel.active) return;
    if (isLassoChrome(e.target)) return;
    e.preventDefault();
  }

  function onSelectionBlockMouseDown(e) {
    if (!sel.active) return;
    if (isLassoChrome(e.target) || e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    if (!canFreestyleDraw() || sel.phase !== "hover") return;

    sel.hoverTarget = null;
    selectionEl().style.display = "none";
    sel.draw.pending = { x: e.clientX, y: e.clientY };
    sel.draw.active = false;
  }

  function onFreezeEvent(e) {
    if (!sel.active) return;
    if (isLassoChrome(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function startCaptureUI({ mode, hideFixed, preview = false }) {
    if (sel.active) cleanupSelection();

    sel.active = true;
    sel.mode = preview ? "pick" : mode;
    sel.hideFixed = !!hideFixed;
    sel.preview = preview;
    sel.rect = null;
    sel.userResized = false;
    sel.hoverTarget = null;
    sel.pickedItems = [];
    sel.pickAnchorDocRect = null;
    sel.pickManualDocRect = null;
    sel.pickPreviewEl = null;
    sel.pickAddInFlight = false;
    sel.pickAddPromise = null;
    sel.draw = { pending: null, active: false, suppressClick: false };

    buildSelectionChrome();

    if (preview) {
      sel.phase = "hover";
      setOverlayDim(true);
      buildPreviewScreen();
      if (hintEl()) hintEl().style.display = "none";
      bindHoverListeners();
      return;
    }

    if (mode === "freestyle" || mode === "pick") {
      sel.phase = "hover";
      setOverlayDim(true);
      hintEl().textContent =
        mode === "freestyle"
          ? "Drag to select a region · Esc to cancel"
          : "Hover an element · click to select · Shift+click to add more · Esc to cancel";
      bindHoverListeners();
      return;
    }

    sel.phase = "locked";
    hintEl().textContent =
      mode === "visible"
        ? "Adjust region · Esc to cancel"
        : "Full page · adjust crop or keep viewport · Esc to cancel";
    lockSelection(viewportRect());
  }

  function buildPreviewScreen() {
    const screen = document.createElement("div");
    screen.id = "lasso-preview-screen";
    screen.innerHTML = `
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
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none" aria-hidden="true">
            <rect width="128" height="128" rx="28" fill="#2563D4"/>
            <rect x="28" y="28" width="72" height="72" rx="10" stroke="#FFFFFF" stroke-width="6" stroke-dasharray="14 10"/>
            <circle cx="34" cy="34" r="8" fill="#FFFFFF"/>
            <path d="M34 34L52 52" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round"/>
          </svg>
        </div>
        <p class="lasso-preview-text">Drag a region, or hover an element and click. Esc cancels.</p>
        <button type="button" class="lasso-preview-cancel" data-action="cancel">Cancel</button>
      </div>
    `;
    screen.addEventListener("click", onPreviewClick);
    document.body.append(screen);
    sel.dom.previewScreen = screen;
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
    sel.mode = mode;
    sel.preview = false;
    sel.phase = "locked";
    unbindHoverListeners();
    hintEl()?.remove();
    sel.dom.hint = null;
    selectionEl().style.display = "none";
    setOverlayDim(false);
    lockSelection(viewportRect());
  }

  function removePreviewScreen() {
    previewScreenEl()?.remove();
    sel.dom.previewScreen = null;
  }

  function viewportRect() {
    return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function buildSelectionChrome() {
    const overlayNode = document.createElement("div");
    overlayNode.id = "lasso-overlay";

    const hintNode = document.createElement("div");
    hintNode.id = "lasso-hint";

    const selectionNode = document.createElement("div");
    selectionNode.id = "lasso-selection";
    selectionNode.className = "lasso-hover";
    selectionNode.style.display = "none";

    const dimensionsNode = document.createElement("div");
    dimensionsNode.id = "lasso-dimensions";
    selectionNode.appendChild(dimensionsNode);

    HANDLE_DIRS.forEach((dir) => {
      const handle = document.createElement("div");
      handle.className = "lasso-handle";
      handle.dataset.dir = dir;
      handle.style.cursor = HANDLE_CURSORS[dir];
      handle.style.display = "none";
      handle.addEventListener("mousedown", (e) => startResize(e, dir));
      selectionNode.appendChild(handle);
    });

    const toolbarNode = document.createElement("div");
    toolbarNode.id = "lasso-toolbar";
    toolbarNode.innerHTML = `
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
    toolbarNode.addEventListener("click", onToolbarClick);
    selectionNode.appendChild(toolbarNode);

    sel.dom = {
      overlay: overlayNode,
      selection: selectionNode,
      dimensions: dimensionsNode,
      toolbar: toolbarNode,
      hint: hintNode,
      previewScreen: sel.dom.previewScreen,
    };

    document.body.append(overlayNode, selectionNode, hintNode);
    document.documentElement.classList.add("lasso-active");
    clearPageSelection();
    document.addEventListener("keydown", onSelectionKeyDown, true);
    bindFreezeListeners();
    bindSelectionGuardListeners();
  }

  function isLockedPhase() {
    return sel.phase === "locked" || sel.phase === "pick-add";
  }

  function onSelectionKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelOperation();
      return;
    }

    if (!isLockedPhase()) return;

    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    if (e.key.toLowerCase() === "c") {
      e.preventDefault();
      e.stopPropagation();
      void executeCapture("copy");
      return;
    }

    if (e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      void executeCapture("download");
    }
  }

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
    if (!overlay()) return document.elementsFromPoint(x, y);
    overlay().style.pointerEvents = "none";
    const stack = document.elementsFromPoint(x, y);
    overlay().style.pointerEvents = "auto";
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

  function rectFromElement(el) {
    return rectFromDomRect(el.getBoundingClientRect());
  }

  function rectToDocument(rect) {
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  }

  function documentRectToViewport(
    docRect,
    scrollX = window.scrollX,
    scrollY = window.scrollY,
  ) {
    return {
      x: docRect.x - scrollX,
      y: docRect.y - scrollY,
      width: docRect.width,
      height: docRect.height,
    };
  }

  function rectFromElementDocument(el) {
    return rectToDocument(rectFromElement(el));
  }

  function snapshotPickItem(el) {
    return { el, rect: rectFromElementDocument(el) };
  }

  function unionRects(rects) {
    const valid = rects.filter((r) => r.width > 0 && r.height > 0);
    if (!valid.length) return null;

    const left = Math.min(...valid.map((r) => r.x));
    const top = Math.min(...valid.map((r) => r.y));
    const right = Math.max(...valid.map((r) => r.x + r.width));
    const bottom = Math.max(...valid.map((r) => r.y + r.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function pickRectsForUnion(
    extraEl = null,
    scrollX = window.scrollX,
    scrollY = window.scrollY,
  ) {
    const rects = sel.pickedItems.map((item) => {
      if (item.el?.isConnected) return rectFromElement(item.el);
      return documentRectToViewport(item.rect, scrollX, scrollY);
    });
    if (sel.pickAnchorDocRect) {
      rects.push(documentRectToViewport(sel.pickAnchorDocRect, scrollX, scrollY));
    }
    if (sel.pickManualDocRect) {
      rects.push(documentRectToViewport(sel.pickManualDocRect, scrollX, scrollY));
    } else if (!sel.pickedItems.length && sel.rect) {
      rects.push(sel.rect);
    }
    if (extraEl) rects.push(rectFromElement(extraEl));
    return rects;
  }

  function renderLockedPickSelection() {
    const viewUnion = unionRects(pickRectsForUnion(sel.pickPreviewEl));
    if (!viewUnion) {
      if (sel.rect) renderSelection(sel.rect, "locked");
      return;
    }
    renderSelection(normalizeRect(viewUnion), "locked");
  }

  function pickUnionViewportRect(
    scrollX = window.scrollX,
    scrollY = window.scrollY,
  ) {
    return unionRects(pickRectsForUnion(null, scrollX, scrollY));
  }

  function pickCropWouldClip(
    scrollX = window.scrollX,
    scrollY = window.scrollY,
  ) {
    const view = pickUnionViewportRect(scrollX, scrollY);
    if (!view) return false;
    const normalized = normalizeRect(view);
    return (
      normalized.x !== view.x ||
      normalized.y !== view.y ||
      normalized.width !== view.width ||
      normalized.height !== view.height
    );
  }

  async function waitForPickAddIdle() {
    if (sel.pickAddPromise) await sel.pickAddPromise;
  }

  function recomputePickRect(scrollX = window.scrollX, scrollY = window.scrollY) {
    const viewUnion = unionRects(pickRectsForUnion(null, scrollX, scrollY));
    if (!viewUnion) return;

    sel.pickPreviewEl = null;
    sel.rect = normalizeRect(viewUnion);
    renderSelection(sel.rect, "locked");
  }

  async function ensureElementInView(el) {
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
  }

  async function ensurePickUnionInView(extraEl = null) {
    const union = unionRects(pickRectsForUnion(extraEl));
    if (!union) return;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const inView =
      union.y >= 0 &&
      union.x >= 0 &&
      union.y + union.height <= vh &&
      union.x + union.width <= vw;
    if (inView) return;

    let nextX = window.scrollX;
    let nextY = window.scrollY;
    if (union.y < 0) nextY += union.y;
    if (union.x < 0) nextX += union.x;
    if (union.y + union.height > vh) nextY += union.y + union.height - vh;
    if (union.x + union.width > vw) nextX += union.x + union.width - vw;

    window.scrollTo({ left: nextX, top: nextY });
    await new Promise((r) => setTimeout(r, PICK_SCROLL_WAIT_MS));
  }

  async function addPickElement(el) {
    if (sel.pickedItems.some((item) => item.el === el)) return;
    if (sel.pickAddInFlight) {
      await waitForPickAddIdle();
      if (sel.pickedItems.some((item) => item.el === el)) return;
    }

    const work = (async () => {
      const hasExistingPick =
        sel.pickedItems.length > 0 ||
        !!sel.pickAnchorDocRect ||
        !!sel.pickManualDocRect ||
        !!sel.rect;
      if (hasExistingPick) {
        await ensurePickUnionInView(el);
      } else {
        await ensureElementInView(el);
      }
      if (!sel.active) return;

      if (sel.userResized && sel.rect) {
        sel.pickManualDocRect = rectToDocument(sel.rect);
      }
      if (!sel.active) return;

      sel.pickedItems.push(snapshotPickItem(el));
      sel.userResized = false;
      sel.pickPreviewEl = null;
      recomputePickRect();
    })();

    sel.pickAddInFlight = true;
    sel.pickAddPromise = work;
    try {
      await work;
    } finally {
      sel.pickAddInFlight = false;
      if (sel.pickAddPromise === work) sel.pickAddPromise = null;
    }
  }

  function onPickAddMove(e) {
    if (!e.shiftKey) {
      sel.pickPreviewEl = null;
      if (sel.rect) renderSelection(sel.rect, "locked");
      return;
    }
    if (isLassoChrome(e.target)) return;

    const el = resolvePickTarget(e.clientX, e.clientY);
    if (!el) {
      sel.pickPreviewEl = null;
      if (sel.rect) renderSelection(sel.rect, "locked");
      return;
    }

    sel.pickPreviewEl = el;
    renderLockedPickSelection();
  }

  async function onPickAddClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = resolvePickTarget(e.clientX, e.clientY);
    if (!el) return;

    sel.pickPreviewEl = null;
    await addPickElement(el);
  }

  function hideCaptureChrome() {
    clearPageSelection();
    overlay()?.style.setProperty("display", "none", "important");
    selectionEl()?.style.setProperty("display", "none", "important");
    hintEl()?.style.setProperty("display", "none", "important");
    previewScreenEl()?.style.setProperty("display", "none", "important");
    void document.documentElement.offsetHeight;
  }

  function onDrawMouseUp(e) {
    if (!sel.active || !canFreestyleDraw() || !sel.draw.pending) return;
    if (sel.phase !== "hover") return;

    if (sel.draw.active) {
      const rect = rectFromDrag(
        sel.draw.pending.x,
        sel.draw.pending.y,
        e.clientX,
        e.clientY,
      );
      sel.draw.pending = null;
      sel.draw.active = false;
      sel.draw.suppressClick = true;

      if (
        rect.width >= MIN_SELECTION_SIZE &&
        rect.height >= MIN_SELECTION_SIZE
      ) {
        lockSelection(normalizeRect(rect));
        return;
      }

      selectionEl().style.display = "none";
      setOverlayDim(true);
      return;
    }

    sel.draw.pending = null;
  }

  function onHoverMove(e) {
    if (!sel.active || sel.captureInProgress) return;
    if (sel.phase === "pick-add") return onPickAddMove(e);
    if (sel.phase !== "hover") return;

    if (sel.draw.pending && canFreestyleDraw()) {
      const dx = e.clientX - sel.draw.pending.x;
      const dy = e.clientY - sel.draw.pending.y;
      if (!sel.draw.active && Math.hypot(dx, dy) >= DRAW_THRESHOLD) {
        sel.draw.active = true;
        sel.hoverTarget = null;
        setOverlayDim(false);
      }
      if (sel.draw.active) {
        renderSelection(
          normalizeRect(
            rectFromDrag(
              sel.draw.pending.x,
              sel.draw.pending.y,
              e.clientX,
              e.clientY,
            ),
          ),
          "hover",
        );
        return;
      }
    }

    if (sel.draw.active || sel.draw.pending || sel.mode === "freestyle") return;
    if (isLassoChrome(e.target)) {
      sel.hoverTarget = null;
      selectionEl().style.display = "none";
      setOverlayDim(canFreestyleDraw());
      return;
    }

    const el = resolvePickTarget(e.clientX, e.clientY);
    sel.hoverTarget = el;
    if (!el) {
      selectionEl().style.display = "none";
      setOverlayDim(canFreestyleDraw());
      return;
    }

    setOverlayDim(false);
    renderSelection(rectFromElement(el), "hover");
  }

  async function onHoverClick(e) {
    if (!sel.active || sel.captureInProgress || sel.mode === "freestyle") return;
    if (isLassoChrome(e.target)) return;

    if (sel.draw.suppressClick) {
      sel.draw.suppressClick = false;
      return;
    }

    if (sel.phase === "pick-add") {
      if (!e.shiftKey) return;
      return onPickAddClick(e);
    }

    if (isLockedPhase()) return;
    if (sel.draw.pending || sel.draw.active) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = sel.hoverTarget || resolvePickTarget(e.clientX, e.clientY);
    if (!el) return;

    await ensureElementInView(el);
    lockSelection(rectFromElement(el), el);
  }

  function lockSelection(rect, element = null) {
    sel.phase = sel.mode === "pick" ? "pick-add" : "locked";
    sel.userResized = false;
    sel.pickedItems = element ? [snapshotPickItem(element)] : [];
    sel.pickAnchorDocRect = element ? null : rectToDocument(normalizeRect(rect));
    sel.pickManualDocRect = null;
    sel.pickPreviewEl = null;
    sel.rect = normalizeRect(rect);
    sel.draw = { pending: null, active: false, suppressClick: false };
    removePreviewScreen();
    hintEl()?.remove();
    sel.dom.hint = null;

    selectionEl().className = "lasso-locked";
    selectionEl().querySelectorAll(".lasso-handle").forEach((h) => {
      h.style.display = "block";
    });

    if (sel.mode !== "pick") unbindHoverListeners();
    renderSelection(sel.rect, "locked");
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
    if (!sel.active || !selectionEl()) return;
    if (sel.captureInProgress) return;
    if (rect.width <= 0 || rect.height <= 0) {
      selectionEl().style.display = "none";
      return;
    }

    selectionEl().style.display = "block";
    selectionEl().style.top = rect.y + "px";
    selectionEl().style.left = rect.x + "px";
    selectionEl().style.width = rect.width + "px";
    selectionEl().style.height = rect.height + "px";

    let dimensionsLabel =
      Math.round(rect.width) + " \u00d7 " + Math.round(rect.height);
    if (phase === "locked" && sel.pickedItems.length > 1) {
      dimensionsLabel += " \u00b7 " + sel.pickedItems.length + " elements";
    }
    sel.dom.dimensions.textContent = dimensionsLabel;
    sel.dom.dimensions.style.display = phase === "locked" ? "block" : "none";

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

    selectionEl().querySelectorAll(".lasso-handle").forEach((handle) => {
      const [left, top] = positions[handle.dataset.dir];
      handle.style.left = left + "px";
      handle.style.top = top + "px";
    });
  }

  function positionToolbar(rect) {
    if (sel.mode === "visible" || sel.mode === "fullpage") {
      sel.dom.toolbar.classList.add("lasso-toolbar-fixed");
      sel.dom.toolbar.style.left = "";
      sel.dom.toolbar.style.top = "";
      return;
    }

    sel.dom.toolbar.classList.remove("lasso-toolbar-fixed");
    const gap = 8;
    sel.dom.toolbar.style.left = Math.max(0, rect.width - 300) + "px";
    sel.dom.toolbar.style.top = rect.height + gap + "px";
  }

  function startResize(e, dir) {
    if (!isLockedPhase() || !sel.rect) return;

    e.preventDefault();
    e.stopPropagation();
    selectionEl().classList.add("lasso-resizing");
    sel.pickedItems = [];
    sel.pickAnchorDocRect = null;
    sel.pickManualDocRect = null;
    sel.userResized = true;

    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...sel.rect };

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

      sel.rect = normalizeRect({ x, y, width, height });
      renderSelection(sel.rect, "locked");
    }

    function onUp() {
      selectionEl().classList.remove("lasso-resizing");
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
      void executeCapture(action);
    }
  }

  async function executeCapture(action) {
    await waitForPickAddIdle();
    if (!sel.rect) return;

    if (sel.mode === "pick" && pickCropWouldClip()) {
      showNotice(
        "Selection is too large for one screenshot. Pick elements closer together.",
      );
      return;
    }

    sel.captureInProgress = true;
    sel.captureScrollY = window.scrollY;
    hideCaptureChrome();

    chrome.runtime.sendMessage({
      type: LassoMsg.SELECTION_CAPTURE,
      mode: sel.mode,
      hideFixed: sel.hideFixed,
      action,
    });
  }

  function cancelOperation() {
    if (!sel.active && !sel.captureInProgress) return;

    sel.captureInProgress = false;
    chrome.runtime.sendMessage({ type: LassoMsg.CANCEL_CAPTURE });
    window.LassoFixed.restoreFixedElements();
    cleanupSelection();
  }

  function showNotice(message) {
    const notice = document.createElement("div");
    notice.id = "lasso-notice";
    notice.textContent = message;
    document.body.append(notice);
    setTimeout(() => notice.remove(), 4000);
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

  function resetSelectionState() {
    sel.active = false;
    sel.phase = "idle";
    sel.mode = "idle";
    sel.hideFixed = false;
    sel.preview = false;
    sel.rect = null;
    sel.captureInProgress = false;
    sel.captureScrollY = 0;
    sel.userResized = false;
    sel.hoverTarget = null;
    sel.pickedItems = [];
    sel.pickAnchorDocRect = null;
    sel.pickManualDocRect = null;
    sel.pickPreviewEl = null;
    sel.pickAddInFlight = false;
    sel.pickAddPromise = null;
    sel.draw = { pending: null, active: false, suppressClick: false };
  }

  function cleanupSelection(options = {}) {
    resetSelectionState();
    sel.dom.overlay?.remove();
    sel.dom.selection?.remove();
    sel.dom.hint?.remove();
    removePreviewScreen();
    sel.dom = {
      overlay: null,
      selection: null,
      dimensions: null,
      toolbar: null,
      hint: null,
      previewScreen: null,
    };
    unbindHoverListeners();
    unbindFreezeListeners();
    unbindSelectionGuardListeners();
    document.documentElement.classList.remove("lasso-active");
    document.removeEventListener("keydown", onSelectionKeyDown, true);

    if (options.truncated) {
      showNotice("Page exceeded capture limit. Screenshot may be incomplete.");
    }

    if (options.error) {
      showNotice(options.error);
    }
  }

  function onCaptureCancelled() {
    sel.captureInProgress = false;
    window.LassoFixed.restoreFixedElements();
    cleanupSelection();
  }

  function onCaptureFailed(message) {
    sel.captureInProgress = false;
    window.LassoFixed.restoreFixedElements();
    cleanupSelection();
    if (message) showNotice(message);
  }

  function markCaptureInactive() {
    sel.captureInProgress = false;
  }

  window.LassoSelection = {
    startCaptureUI,
    getCaptureParams: async () => {
      await waitForPickAddIdle();
      if (!sel.userResized && sel.pickedItems.length) {
        recomputePickRect(window.scrollX, sel.captureScrollY);
      }
      if (sel.mode === "pick" && pickCropWouldClip(window.scrollX, sel.captureScrollY)) {
        return null;
      }
      return rectForCapture(sel);
    },
    hideCaptureChrome,
    cleanupSelection,
    onCaptureCancelled,
    onCaptureFailed,
    isCaptureActive: () => sel.captureInProgress,
    markCaptureInactive,
  };
})();
