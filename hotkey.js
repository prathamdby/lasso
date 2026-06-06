(() => {
  if (window.__lassoHotkeyLoaded || window.top !== window) return;
  window.__lassoHotkeyLoaded = true;

  document.addEventListener(
    "keydown",
    (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || !e.shiftKey || e.altKey) return;
      if (e.key !== "S" && e.key !== "s") return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      chrome.runtime.sendMessage({
        type: LassoMsg.OPEN_PREVIEW,
        hideFixed: false,
      });
    },
    true,
  );
})();
