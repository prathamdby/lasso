(() => {
  if (window.__lassoFixedLoaded) return;
  window.__lassoFixedLoaded = true;

  const LASSO_ROOT_SELECTOR =
    "#lasso-overlay, #lasso-selection, #lasso-hint, #lasso-preview-screen";

  let hiddenFixed = [];

  function isLassoRoot(el) {
    return !!el?.closest?.(LASSO_ROOT_SELECTOR);
  }

  function hideFixedElements() {
    restoreFixedElements();

    const root = document.body || document.documentElement;
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
        hiddenFixed.push({ el: node, visibility: node.style.visibility });
        node.style.visibility = "hidden";
      }
      node = walker.nextNode();
    }
  }

  function restoreFixedElements() {
    hiddenFixed.forEach(({ el, visibility }) => {
      el.style.visibility = visibility;
    });
    hiddenFixed = [];
  }

  window.LassoFixed = { hideFixedElements, restoreFixedElements };
})();
