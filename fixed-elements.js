(() => {
  if (window.__lassoFixedLoaded) return;
  window.__lassoFixedLoaded = true;

  if (!window.LassoGeometry) {
    throw new Error("Lasso: geometry.js must load before fixed-elements.js");
  }

  const LASSO_ROOT_SELECTOR =
    "#lasso-overlay, #lasso-selection, #lasso-hint, #lasso-preview-screen";

  // Properties pinning overwrites. Captured before the first write so a release
  // restores exactly what the page had, including its own inline styles. Margin
  // is listed as longhands because clearing the shorthand would also clear
  // longhands the page set on their own, which capture never recorded.
  const PINNED_PROPERTIES = [
    "position",
    "top",
    "left",
    "width",
    "height",
    "min-height",
    "max-height",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "visibility",
  ];

  // Elements shorter than this share of the viewport cannot be sized by it in
  // any way that matters for a full-page render.
  const VIEWPORT_SIZED_MIN_RATIO = 0.25;
  const ANIMATION_SETTLE_MS = 600;

  // Restore log, in application order. `handled` keeps a sweep from touching an
  // element twice, which would capture already-overwritten inline styles. An
  // element can still be logged again later (a freeze, or a re-hide), so
  // release replays the log newest-first.
  let pinned = [];
  let handled = new WeakSet();
  let absolutePinned = new Set();
  let viewportSnapshot = null;

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function isLassoRoot(el) {
    return !!el?.closest?.(LASSO_ROOT_SELECTOR);
  }

  function collectStuck(root) {
    const found = [];

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (isLassoRoot(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node = walker.nextNode();
    while (node) {
      const style = getComputedStyle(node);
      if (style.position === "fixed" || style.position === "sticky") {
        found.push({ el: node, style });
      }
      // A TreeWalker stops at the shadow boundary, so open roots need their own
      // walk. Closed roots are unreachable and will still repeat.
      if (node.shadowRoot) {
        found.push(...collectStuck(node.shadowRoot));
      }
      node = walker.nextNode();
    }

    return found;
  }

  // An absolutely positioned element resolves against the nearest ancestor that
  // establishes a containing block, not against the document.
  function containingBlockOf(el) {
    let parent = el.parentElement;
    while (parent) {
      if (LassoGeometry.establishesContainingBlock(getComputedStyle(parent))) {
        return parent;
      }
      parent = parent.parentElement;
    }
    return null;
  }

  function documentRectOf(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  }

  // getBoundingClientRect reports the transformed box. Pinning writes top/left
  // as layout position, and the element's own transform then applies again on
  // top of it. Measure with the transform suppressed so it applies exactly once
  // and the element keeps its rendered position.
  function layoutRectOf(el) {
    const inline = el.style.getPropertyValue("transform");
    const priority = el.style.getPropertyPriority("transform");
    el.style.setProperty("transform", "none", "important");

    const rect = documentRectOf(el);

    el.style.removeProperty("transform");
    if (inline) el.style.setProperty("transform", inline, priority);
    return rect;
  }

  function rememberInlineStyles(el) {
    const inline = {};
    for (const prop of PINNED_PROPERTIES) {
      inline[prop] = {
        value: el.style.getPropertyValue(prop),
        priority: el.style.getPropertyPriority(prop),
      };
    }
    pinned.push({ el, inline });
  }

  function set(el, prop, value) {
    // Page stylesheets routinely mark `position` important; outrank them.
    el.style.setProperty(prop, value, "important");
  }

  function pin(el) {
    const target = layoutRectOf(el);
    const container = containingBlockOf(el);
    let containerRect = null;
    let containerBorder = null;

    if (container) {
      const style = getComputedStyle(container);
      containerRect = documentRectOf(container);
      containerBorder = {
        top: parseFloat(style.borderTopWidth) || 0,
        left: parseFloat(style.borderLeftWidth) || 0,
      };
    }

    const { top, left } = LassoGeometry.absoluteOffsetFor(
      target,
      containerRect,
      containerBorder,
    );

    rememberInlineStyles(el);
    set(el, "position", "absolute");
    set(el, "top", `${top}px`);
    set(el, "left", `${left}px`);
    // A viewport-sized element re-resolves against the new containing block, so
    // freeze the measured size. Margins offset from the viewport edge and would
    // double-apply against the computed offset.
    set(el, "width", `${target.width}px`);
    set(el, "height", `${target.height}px`);
    set(el, "margin-top", "0");
    set(el, "margin-right", "0");
    set(el, "margin-bottom", "0");
    set(el, "margin-left", "0");
  }

  function hide(el) {
    rememberInlineStyles(el);
    set(el, "visibility", "hidden");
  }

  function unstick(el) {
    rememberInlineStyles(el);
    set(el, "position", "static");
  }

  // Waits for finite animations and transitions inside the given elements, so a
  // navbar sliding back in after a scroll is pinned where it settles, not
  // mid-transition. Infinite animations (spinners) never finish and are skipped.
  async function settleAnimations(elements) {
    const finished = [];
    for (const el of elements) {
      if (typeof el.getAnimations !== "function") continue;
      for (const animation of el.getAnimations({ subtree: true })) {
        const end = animation.effect?.getComputedTiming?.().endTime;
        if (animation.playState === "running" && Number.isFinite(end)) {
          finished.push(animation.finished.catch(() => {}));
        }
      }
    }
    if (!finished.length) return false;

    await Promise.race([
      Promise.all(finished),
      new Promise((resolve) => setTimeout(resolve, ANIMATION_SETTLE_MS)),
    ]);
    return true;
  }

  // A pinned element that the page's own code resets (a framework re-render
  // rewriting the style attribute) goes back to fixed and would repeat.
  function hideUnpinned() {
    let changed = false;
    for (const el of [...absolutePinned]) {
      if (getComputedStyle(el).position === "absolute") continue;
      absolutePinned.delete(el);
      hide(el);
      changed = true;
    }
    return changed;
  }

  // Converts fixed and sticky elements into ordinary document content so a
  // full-page capture renders them once instead of in every slice. Safe to call
  // repeatedly: elements handled by an earlier sweep are left alone. Fixed
  // elements first seen after scrolling are hidden rather than pinned, because
  // pinning them would land them partway down the page.
  async function pinFixedElements() {
    const root = document.body || document.documentElement;
    let stuck = collectStuck(root);
    const fresh = stuck.filter(({ el }) => !handled.has(el));
    // Animations moved things, so the earlier walk is stale.
    if (fresh.length && (await settleAnimations(fresh.map(({ el }) => el)))) {
      stuck = collectStuck(root);
    }

    let changed = hideUnpinned();
    const seenScrolled = window.scrollY > 0;

    for (const { el, style } of stuck) {
      if (handled.has(el)) continue;
      handled.add(el);
      changed = true;

      const treatment = LassoGeometry.treatmentFor(
        style.position,
        el.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
        { seenScrolled },
      );

      if (treatment === "hide") hide(el);
      else if (treatment === "release") unstick(el);
      else {
        pin(el);
        absolutePinned.add(el);
      }
    }

    // Reply only once the page has painted the new positions.
    if (changed) {
      await nextFrame();
      await nextFrame();
    }
  }

  function measureCandidates(elements) {
    return elements.map((el) => el.getBoundingClientRect().height);
  }

  // Records the heights of elements big enough to be sized by the viewport.
  // Pairs with freezeViewportSized, which compares against a resized viewport.
  function snapshotViewportSized() {
    const min = window.innerHeight * VIEWPORT_SIZED_MIN_RATIO;
    const elements = [];
    for (const el of document.querySelectorAll("*")) {
      if (isLassoRoot(el)) continue;
      if (el.getBoundingClientRect().height >= min) elements.push(el);
    }
    viewportSnapshot = { elements, heights: measureCandidates(elements) };
    return { count: elements.length };
  }

  // `captureBeyondViewport` can resize the viewport, which grows anything sized
  // in `vh`. Called while the viewport is enlarged by `delta`: elements that
  // followed it are pinned to the height they had before.
  function freezeViewportSized(delta) {
    if (!viewportSnapshot) return { frozen: 0 };
    const { elements, heights } = viewportSnapshot;
    viewportSnapshot = null;

    const indices = LassoGeometry.viewportSizedIndices(
      heights,
      measureCandidates(elements),
      delta,
    );

    for (const index of indices) {
      const el = elements[index];
      const height = `${heights[index]}px`;
      rememberInlineStyles(el);
      set(el, "height", height);
      set(el, "min-height", height);
      set(el, "max-height", height);
    }
    return { frozen: indices.length };
  }

  function releaseFixedElements() {
    for (const { el, inline } of pinned.reverse()) {
      for (const prop of PINNED_PROPERTIES) {
        const { value, priority } = inline[prop];
        el.style.removeProperty(prop);
        if (value) el.style.setProperty(prop, value, priority);
      }
    }
    pinned = [];
    handled = new WeakSet();
    absolutePinned = new Set();
    viewportSnapshot = null;
  }

  window.LassoFixed = {
    pinFixedElements,
    snapshotViewportSized,
    freezeViewportSized,
    releaseFixedElements,
  };
})();
