(() => {
  if (window.__lassoSelectionLoaded) return;
  window.__lassoSelectionLoaded = true;

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
  const FORMAT_CHIPS = ["png", "jpeg", "webp"];
  const FORMAT_CHIP_SET = new Set(FORMAT_CHIPS);
  const DEFAULT_FORMAT = "png";
  const SETTLE_FRAMES = 10;
  const SETTLE_STABLE_FRAMES = 3;
  const SETTLE_EPSILON = 1;

  // Synchronously-readable copy of the stored format so the toolbar paints the
  // correct chip on its first frame, rather than flashing the PNG default while
  // the async storage read resolves. Kept fresh by the change listener below
  // and by selectFormat.
  let cachedFormat = DEFAULT_FORMAT;
  try {
    chrome.storage.local.get("lassoFormat", ({ lassoFormat }) => {
      if (FORMAT_CHIP_SET.has(lassoFormat)) cachedFormat = lassoFormat;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      const next = changes.lassoFormat?.newValue;
      if (area === "local" && FORMAT_CHIP_SET.has(next)) cachedFormat = next;
    });
  } catch {
    // storage unavailable; the default chip stays selected
  }

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
    pickedEls: new Set(),
    pickAnchorDocRect: null,
    pickManualDocRect: null,
    pickPreviewEl: null,
    pickAddInFlight: false,
    pickAddPromise: null,
    formatPicked: false,
    draw: { pending: null, active: false, suppressClick: false },
    dom: {
      overlay: null,
      selection: null,
      dimensions: null,
      toolbar: null,
      handles: [],
      formatChips: [],
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

  function setPickedItems(items) {
    sel.pickedItems = items;
    sel.pickedEls = new Set();
    for (const item of items) {
      if (item.el) sel.pickedEls.add(item.el);
    }
  }

  function clearPickedItems() {
    setPickedItems([]);
  }

  function hasPickedElement(el) {
    return sel.pickedEls.has(el);
  }

  function addPickedElement(el) {
    sel.pickedItems.push(snapshotPickItem(el));
    sel.pickedEls.add(el);
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
    clearPickedItems();
    sel.pickAnchorDocRect = null;
    sel.pickManualDocRect = null;
    sel.pickPreviewEl = null;
    sel.pickAddInFlight = false;
    sel.pickAddPromise = null;
    sel.formatPicked = false;
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

    const handles = HANDLE_DIRS.map((dir) => {
      const handle = document.createElement("div");
      handle.className = "lasso-handle";
      handle.dataset.dir = dir;
      handle.style.cursor = HANDLE_CURSORS[dir];
      handle.style.display = "none";
      handle.addEventListener("mousedown", (e) => startResize(e, dir));
      selectionNode.appendChild(handle);
      return handle;
    });

    const toolbarNode = document.createElement("div");
    toolbarNode.id = "lasso-toolbar";
    toolbarNode.innerHTML = `
      <button type="button" class="lasso-btn-close" data-action="close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
      <span class="lasso-toolbar-divider" aria-hidden="true"></span>
      <div class="lasso-format-group" role="group" aria-label="Download format">
        <button type="button" class="lasso-format-chip" data-format="png" aria-pressed="true">PNG</button>
        <button type="button" class="lasso-format-chip" data-format="jpeg" aria-pressed="false">JPEG</button>
        <button type="button" class="lasso-format-chip" data-format="webp" aria-pressed="false">WebP</button>
      </div>
      <span class="lasso-toolbar-divider" aria-hidden="true"></span>
      <button type="button" class="lasso-btn-text" data-action="text" aria-label="Extract text">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V5h16v2M9 19h6M12 5v14"/></svg>
        Text
      </button>
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
    const formatChips = Array.from(
      toolbarNode.querySelectorAll(".lasso-format-chip"),
    );

    sel.dom = {
      overlay: overlayNode,
      selection: selectionNode,
      dimensions: dimensionsNode,
      toolbar: toolbarNode,
      handles,
      formatChips,
      hint: hintNode,
      previewScreen: sel.dom.previewScreen,
    };

    document.body.append(overlayNode, selectionNode, hintNode);
    document.documentElement.classList.add("lasso-active");
    clearPageSelection();
    document.addEventListener("keydown", onSelectionKeyDown, true);
    bindFreezeListeners();
    bindSelectionGuardListeners();
    highlightFormat(cachedFormat);
    syncToolbarFormat();
  }

  function highlightFormat(format) {
    sel.dom.formatChips.forEach((chip) => {
      const active = chip.dataset.format === format;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function syncToolbarFormat() {
    try {
      chrome.storage.local.get("lassoFormat", ({ lassoFormat }) => {
        const format = FORMAT_CHIP_SET.has(lassoFormat)
          ? lassoFormat
          : DEFAULT_FORMAT;
        cachedFormat = format;
        // This async read can resolve after a fast chip click or after the
        // toolbar was torn down/rebuilt. In both cases the user's choice (or
        // the new session) wins, so don't overwrite it with the stored value.
        if (sel.formatPicked || !sel.dom.toolbar) return;
        highlightFormat(format);
      });
    } catch {
      highlightFormat(DEFAULT_FORMAT);
    }
  }

  function selectFormat(format) {
    if (!FORMAT_CHIP_SET.has(format)) return;
    sel.formatPicked = true;
    cachedFormat = format;
    highlightFormat(format);
    // The capture pipeline reads this at export time, so the choice applies
    // to the next download (and persists for future captures).
    try {
      chrome.storage.local.set({ lassoFormat: format });
    } catch {
      // storage unavailable; highlight still reflects the choice
    }
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
    const stack = elementsUnderPoint(x, y);
    let candidate = null;
    let fallback = null;

    for (const el of stack) {
      if (!isPageEl(el)) continue;

      if (el.matches("img, video, picture, svg, canvas, [role='img']")) {
        return el;
      }

      if (el === document.body || el === document.documentElement) continue;
      if (!fallback) fallback = el;
      if (candidate) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (isLayoutShell(rect)) continue;

      candidate = el;
    }

    if (!candidate) candidate = fallback;
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
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;

    for (const rect of rects) {
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      left = Math.min(left, rect.x);
      top = Math.min(top, rect.y);
      right = Math.max(right, rect.x + rect.width);
      bottom = Math.max(bottom, rect.y + rect.height);
    }

    if (left === Infinity) return null;
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
      rects.push(
        documentRectToViewport(sel.pickAnchorDocRect, scrollX, scrollY),
      );
    }
    if (sel.pickManualDocRect) {
      rects.push(
        documentRectToViewport(sel.pickManualDocRect, scrollX, scrollY),
      );
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

  function recomputePickRect(
    scrollX = window.scrollX,
    scrollY = window.scrollY,
  ) {
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
      el.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "instant",
      });
      await waitForViewportSettle(el);
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

    window.scrollTo({ left: nextX, top: nextY, behavior: "instant" });
    await waitForViewportSettle(extraEl);
  }

  async function addPickElement(el) {
    if (hasPickedElement(el)) return;
    if (sel.pickAddInFlight) {
      await waitForPickAddIdle();
      if (hasPickedElement(el)) return;
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

      addPickedElement(el);
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

  function waitForFrame() {
    return new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
  }

  async function waitForPaint() {
    await waitForFrame();
    await waitForFrame();
  }

  function viewportState(el = null) {
    const rect = el?.getBoundingClientRect();
    return {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      x: rect ? rect.x : 0,
      y: rect ? rect.y : 0,
      width: rect ? rect.width : 0,
      height: rect ? rect.height : 0,
    };
  }

  function nearValue(a, b) {
    return Math.abs(a - b) <= SETTLE_EPSILON;
  }

  function sameViewportState(a, b) {
    return (
      nearValue(a.scrollX, b.scrollX) &&
      nearValue(a.scrollY, b.scrollY) &&
      nearValue(a.x, b.x) &&
      nearValue(a.y, b.y) &&
      nearValue(a.width, b.width) &&
      nearValue(a.height, b.height)
    );
  }

  async function waitForViewportSettle(el = null) {
    let last = null;
    let stableFrames = 0;
    for (let frame = 0; frame < SETTLE_FRAMES; frame += 1) {
      await waitForFrame();
      const current = viewportState(el);
      if (last && sameViewportState(current, last)) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
      }
      if (stableFrames >= SETTLE_STABLE_FRAMES) return;
      last = current;
    }
  }

  async function prepareCaptureChrome() {
    hideCaptureChrome();
    await waitForPaint();
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
    if (!sel.active || sel.captureInProgress || sel.mode === "freestyle")
      return;
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
    setPickedItems(element ? [snapshotPickItem(element)] : []);
    sel.pickAnchorDocRect = element
      ? null
      : rectToDocument(normalizeRect(rect));
    sel.pickManualDocRect = null;
    sel.pickPreviewEl = null;
    sel.rect = normalizeRect(rect);
    sel.draw = { pending: null, active: false, suppressClick: false };
    removePreviewScreen();
    hintEl()?.remove();
    sel.dom.hint = null;

    selectionEl().className = "lasso-locked";
    sel.dom.handles.forEach((handle) => {
      handle.style.display = "block";
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

    sel.dom.handles.forEach((handle) => {
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
    const toolbarWidth = sel.dom.toolbar.offsetWidth || 300;
    sel.dom.toolbar.style.left = Math.max(0, rect.width - toolbarWidth) + "px";
    sel.dom.toolbar.style.top = rect.height + gap + "px";
  }

  function startResize(e, dir) {
    if (!isLockedPhase() || !sel.rect) return;

    e.preventDefault();
    e.stopPropagation();
    selectionEl().classList.add("lasso-resizing");
    clearPickedItems();
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
    const chip = e.target.closest(".lasso-format-chip");
    if (chip) {
      e.preventDefault();
      e.stopPropagation();
      selectFormat(chip.dataset.format);
      return;
    }

    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    const action = btn.dataset.action;
    if (action === "close") {
      cancelOperation();
      return;
    }

    if (action === "text") {
      void extractText();
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

  // Hybrid text extraction: prefer real DOM text under the selection (instant,
  // exact); fall back to OCR on the captured pixels when there's none (images,
  // canvas, video).
  async function extractText() {
    await waitForPickAddIdle();
    if (!sel.rect) return;

    const rect = { ...sel.rect };
    const fullpage = sel.mode === "fullpage";

    const dom = collectSelectionText();
    if (isMeaningfulText(dom.text)) {
      cleanupSelection();
      showTextResult({
        text: dom.text,
        range: dom.range,
        words: dom.words,
        rect,
        fullpage,
      });
      return;
    }

    if (sel.mode === "pick" && pickCropWouldClip()) {
      showNotice(
        "Selection is too large for one screenshot. Pick elements closer together.",
      );
      return;
    }

    pendingOcr = { rect, fullpage, dpr: window.devicePixelRatio };
    sel.captureInProgress = true;
    sel.captureScrollY = window.scrollY;
    hideCaptureChrome();

    chrome.runtime.sendMessage({
      type: LassoMsg.SELECTION_CAPTURE,
      mode: sel.mode,
      hideFixed: sel.hideFixed,
      action: "ocr",
    });
  }

  function collectSelectionText() {
    // Element picks are discrete and bounded, so select them natively.
    if (sel.pickedItems.length) {
      const text = sel.pickedItems
        .map((item) => (item.el?.isConnected ? item.el.innerText || "" : ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const els = sel.pickedItems
        .map((i) => i.el)
        .filter((e) => e?.isConnected);
      let range = null;
      if (els.length) {
        range = document.createRange();
        try {
          range.setStartBefore(els[0]);
          range.setEndAfter(els[els.length - 1]);
        } catch {
          range = null;
        }
      }
      return { text, range, words: null };
    }

    // Freestyle/region: gather only the words whose box falls in the rect, so
    // the result is precise instead of sweeping the whole page.
    const words = collectWordsInRect(sel.rect);
    return {
      text: words
        .map((w) => w.text)
        .join(" ")
        .trim(),
      range: null,
      words,
    };
  }

  function collectWordsInRect(rect) {
    const root = document.body;
    if (!root) return [];

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!isPageEl(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const words = [];
    let node;
    while ((node = walker.nextNode())) {
      const nodeRange = document.createRange();
      nodeRange.selectNodeContents(node);
      if (!rectsIntersect(nodeRange.getBoundingClientRect(), rect)) continue;

      const value = node.nodeValue;
      const token = /\S+/g;
      let m;
      while ((m = token.exec(value))) {
        const wordRange = document.createRange();
        try {
          wordRange.setStart(node, m.index);
          wordRange.setEnd(node, m.index + m[0].length);
        } catch {
          continue;
        }
        const r = wordRange.getBoundingClientRect();
        if (r.width && r.height && rectsIntersect(r, rect)) {
          words.push({
            text: m[0],
            rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          });
        }
      }
    }
    return words;
  }

  function rectsIntersect(a, b) {
    return (
      a.left < b.x + b.width &&
      a.left + a.width > b.x &&
      a.top < b.y + b.height &&
      a.top + a.height > b.y
    );
  }

  function isMeaningfulText(text) {
    return (
      !!text && text.replace(/\s/g, "").length >= 2 && /[\p{L}\p{N}]/u.test(text)
    );
  }

  // Result UI: a small floating bar (Copy / Close). For OCR the recognized
  // words are also laid over the image as an invisible, selectable layer
  // (Live Text); for real page text the underlying DOM is selected in place.
  let textUi = null;
  let pendingOcr = null;

  function buildTextBar() {
    const bar = document.createElement("div");
    bar.id = "lasso-text-bar";
    bar.innerHTML = `
      <span class="lasso-text-status" role="status"></span>
      <button type="button" class="lasso-text-copy" data-text="copy">Copy</button>
      <button type="button" class="lasso-text-close" data-text="close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    `;
    bar.addEventListener("click", onTextBarClick);
    document.body.append(bar);
    document.addEventListener("keydown", onTextKeyDown, true);
    textUi = {
      bar,
      overlay: null,
      status: bar.querySelector(".lasso-text-status"),
      copyBtn: bar.querySelector(".lasso-text-copy"),
      getText: () => "",
      target: null,
    };
    return textUi;
  }

  function positionTextBar(rect, fullpage) {
    const bar = textUi.bar;
    const margin = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = bar.offsetWidth || 180;
    const bh = bar.offsetHeight || 40;

    let left = fullpage
      ? (vw - bw) / 2
      : Math.min(rect.x + rect.width - bw, vw - bw - margin);
    let top = fullpage ? margin : rect.y + rect.height + 8;
    left = Math.max(margin, left);
    if (top + bh > vh - margin) top = Math.max(margin, rect.y - bh - 8);

    bar.style.left = Math.round(left) + "px";
    bar.style.top = Math.round(top) + "px";
  }

  // DOM text result. Element picks select natively; region picks get the same
  // invisible word overlay as OCR, bounded to the drawn rectangle.
  function showTextResult({ text, range, words, rect, fullpage }) {
    buildTextBar();
    textUi.getText = () => text;
    textUi.status.textContent = "";
    textUi.copyBtn.disabled = !text;

    if (words && words.length) {
      renderWordOverlay(
        words.map((w) => ({
          text: w.text,
          left: w.rect.x - rect.x,
          top: w.rect.y - rect.y,
          width: w.rect.width,
          height: w.rect.height,
        })),
        rect,
      );
    } else if (range) {
      selectRange(range);
    }
    positionTextBar(rect, fullpage);
  }

  function selectRange(range) {
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    try {
      selection.addRange(range);
    } catch {
      // range may be invalid after layout changes
    }
  }

  // Invisible, selectable words laid over the captured region. `items` are in
  // CSS pixels relative to the rect origin.
  function renderWordOverlay(items, rect) {
    const overlay = document.createElement("div");
    overlay.id = "lasso-text-layer";
    overlay.style.left = rect.x + "px";
    overlay.style.top = rect.y + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";

    for (const it of items) {
      const span = document.createElement("span");
      span.className = "lasso-text-word";
      // Trailing space keeps copied/selected text word-separated.
      span.textContent = it.text + " ";
      span.style.left = it.left + "px";
      span.style.top = it.top + "px";
      span.style.width = it.width + "px";
      span.style.height = it.height + "px";
      span.style.fontSize = Math.max(6, it.height * 0.86) + "px";
      overlay.appendChild(span);
    }
    document.body.append(overlay);
    textUi.overlay = overlay;
  }

  function onTextBarClick(e) {
    const btn = e.target.closest("[data-text]");
    if (!btn) return;
    e.preventDefault();
    if (btn.dataset.text === "close") return closeTextUi();
    if (btn.dataset.text === "copy") return void copyText();
  }

  function onTextKeyDown(e) {
    if (!textUi || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeTextUi();
  }

  async function copyText() {
    if (!textUi) return;
    const selected = window.getSelection?.().toString().trim();
    const text = selected || textUi.getText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showNotice("Text copied to clipboard");
    } catch {
      // leave the selection so the user can copy manually
    }
  }

  function closeTextUi() {
    if (!textUi) return;
    document.removeEventListener("keydown", onTextKeyDown, true);
    window.getSelection()?.removeAllRanges();
    textUi.overlay?.remove();
    textUi.bar.remove();
    textUi = null;
  }

  function onOcrStarted(options = {}) {
    sel.captureInProgress = false;
    window.LassoFixed.restoreFixedElements();
    const target = pendingOcr || {
      rect: { x: 0, y: 0, width: 320, height: 0 },
      fullpage: true,
      dpr: window.devicePixelRatio,
    };
    pendingOcr = null;
    cleanupSelection(options);
    buildTextBar();
    textUi.target = target;
    textUi.status.textContent = "Recognizing text…";
    textUi.copyBtn.disabled = true;
    positionTextBar(target.rect, target.fullpage);
  }

  function onOcrProgress(progress) {
    if (!textUi) return;
    textUi.status.textContent = `Recognizing text… ${Math.round((progress || 0) * 100)}%`;
  }

  function onOcrResult(text, words) {
    if (!textUi) return;
    const value = (text || "").trim();
    textUi.getText = () => value;
    textUi.copyBtn.disabled = !value;
    textUi.status.textContent = value ? "" : "No text found";

    if (value && words?.length && textUi.target && !textUi.target.fullpage) {
      const { rect, dpr } = textUi.target;
      const d = dpr || 1;
      const items = words
        .filter((w) => w.bbox)
        .map((w) => ({
          text: w.text,
          left: w.bbox.x0 / d,
          top: w.bbox.y0 / d,
          width: (w.bbox.x1 - w.bbox.x0) / d,
          height: (w.bbox.y1 - w.bbox.y0) / d,
        }));
      renderWordOverlay(items, rect);
      positionTextBar(rect, textUi.target.fullpage);
    }
  }

  function onOcrError(message) {
    if (!textUi) {
      showNotice(message || "Text recognition failed");
      return;
    }
    textUi.status.textContent = message || "Text recognition failed";
    textUi.copyBtn.disabled = true;
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
      ".lasso-handle, #lasso-toolbar, #lasso-preview-screen, .lasso-preview-action, .lasso-preview-cancel, #lasso-text-layer, #lasso-text-bar",
    );
  }

  function isPageEl(el) {
    return (
      !!el &&
      !el.closest?.(
        "#lasso-overlay, #lasso-selection, #lasso-hint, #lasso-preview-screen, #lasso-text-layer, #lasso-text-bar",
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
    sel.formatPicked = false;
    sel.hoverTarget = null;
    clearPickedItems();
    sel.pickAnchorDocRect = null;
    sel.pickManualDocRect = null;
    sel.pickPreviewEl = null;
    sel.pickAddInFlight = false;
    sel.pickAddPromise = null;
    sel.draw = { pending: null, active: false, suppressClick: false };
  }

  function cleanupSelection(options = {}) {
    closeTextUi();
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
      handles: [],
      formatChips: [],
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
      if (
        sel.mode === "pick" &&
        pickCropWouldClip(window.scrollX, sel.captureScrollY)
      ) {
        return null;
      }
      return rectForCapture(sel);
    },
    hideCaptureChrome,
    prepareCaptureChrome,
    cleanupSelection,
    onCaptureCancelled,
    onCaptureFailed,
    onOcrStarted,
    onOcrProgress,
    onOcrResult,
    onOcrError,
    isCaptureActive: () => sel.captureInProgress,
    markCaptureInactive,
  };
})();
