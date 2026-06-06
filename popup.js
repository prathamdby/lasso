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
  chrome.runtime.sendMessage({ type: "capture", mode, hideFixed });
  window.close();
}
