(() => {
  if (window.__lassoFixedLoaded) return;
  window.__lassoFixedLoaded = true;

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
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "visibility",
  ];

  // Restore log, in application order. `handled` keeps a sweep from touching an
  // element twice, which would capture already-overwritten inline styles.
  let pinned = [];
  let handled = new WeakSet();

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
      const style = getComputedStyle(parent);
      if (
        style.position !== "static" ||
        style.transform !== "none" ||
        style.filter !== "none" ||
        style.perspective !== "none" ||
        style.willChange.includes("transform")
      ) {
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
    const target = documentRectOf(el);
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

  // Converts fixed and sticky elements into ordinary document content so a
  // scroll-and-stitch capture renders them once instead of in every slice.
  // Safe to call after every scroll: elements handled by an earlier sweep are
  // left alone, and navbars that only become fixed past a scroll threshold are
  // caught where they first appear.
  function pinFixedElements() {
    for (const { el, style } of collectStuck(
      document.body || document.documentElement,
    )) {
      if (handled.has(el)) continue;
      handled.add(el);

      const treatment = LassoGeometry.treatmentFor(
        style.position,
        el.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
      );

      if (treatment === "hide") hide(el);
      else if (treatment === "release") unstick(el);
      else pin(el);
    }
  }

  function releaseFixedElements() {
    for (const { el, inline } of pinned) {
      for (const prop of PINNED_PROPERTIES) {
        const { value, priority } = inline[prop];
        el.style.removeProperty(prop);
        if (value) el.style.setProperty(prop, value, priority);
      }
    }
    pinned = [];
    handled = new WeakSet();
  }

  window.LassoFixed = { pinFixedElements, releaseFixedElements };
})();
