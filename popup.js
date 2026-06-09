document
  .getElementById("btn-visible")
  .addEventListener("click", () => capture("visible"));
document
  .getElementById("btn-fullpage")
  .addEventListener("click", () => capture("fullpage"));
document
  .getElementById("btn-pick")
  .addEventListener("click", () => capture("pick"));
document
  .getElementById("btn-freestyle")
  .addEventListener("click", () => capture("freestyle"));

function capture(mode) {
  const hideFixed = document.getElementById("hide-fixed").checked;
  chrome.runtime.sendMessage({
    type: LassoMsg.CAPTURE,
    mode,
    hideFixed,
  });
  window.close();
}

// Gemini API key — stored locally, never bundled. Powers the Text button.
const keyInput = document.getElementById("gemini-key");
const saveBtn = document.getElementById("gemini-save");

chrome.storage.local.get("lassoGeminiKey").then(({ lassoGeminiKey }) => {
  if (lassoGeminiKey) keyInput.value = lassoGeminiKey;
});

function saveKey() {
  chrome.storage.local
    .set({ lassoGeminiKey: keyInput.value.trim() })
    .then(() => {
      saveBtn.textContent = "Saved";
    })
    .catch(() => {
      saveBtn.textContent = "Failed";
    })
    .finally(() => {
      setTimeout(() => {
        saveBtn.textContent = "Save";
      }, 1200);
    });
}

saveBtn.addEventListener("click", saveKey);
keyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveKey();
});
