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

const FORMAT_OPTIONS = new Set(["png", "jpeg", "webp"]);
const DEFAULT_FORMAT = "png";
const formatSelect = document.getElementById("format-select");
let formatTouched = false;
let formatSave = Promise.resolve();

formatSelect.value = DEFAULT_FORMAT;
formatSelect.addEventListener("change", () => {
  formatTouched = true;
  void saveFormat(formatSelect.value);
});

const formatReady = loadFormat();

function normalizeFormat(format) {
  return FORMAT_OPTIONS.has(format) ? format : DEFAULT_FORMAT;
}

function saveFormat(format) {
  const nextFormat = normalizeFormat(format);
  formatSelect.value = nextFormat;
  formatSave = formatSave.then(() => writeFormat(nextFormat));
  return formatSave;
}

function loadFormat() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get("lassoFormat", ({ lassoFormat }) => {
        if (!formatTouched) formatSelect.value = normalizeFormat(lassoFormat);
        resolve();
      });
    } catch {
      formatSelect.value = DEFAULT_FORMAT;
      resolve();
    }
  });
}

function writeFormat(format) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ lassoFormat: format }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

async function capture(mode) {
  await formatReady;
  await saveFormat(formatSelect.value);
  const hideFixed = document.getElementById("hide-fixed").checked;
  chrome.runtime.sendMessage({
    type: LassoMsg.CAPTURE,
    mode,
    hideFixed,
  });
  window.close();
}
