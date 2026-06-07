// Runs Tesseract OCR in an offscreen document. Content scripts cannot create
// an extension-origin Worker on an arbitrary page (same-origin policy), and the
// service worker cannot host WASM workers, so the heavy lifting lives here.

const VENDOR = "vendor/tesseract";

// WASM SIMD is near-universal but not guaranteed; pick the SIMD core when it's
// supported and fall back to the plain LSTM core otherwise.
function hasWasmSimd() {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10,
        10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}

const CORE_FILE = hasWasmSimd()
  ? "tesseract-core-simd-lstm.wasm.js"
  : "tesseract-core-lstm.wasm.js";

// Lazily created and reused across requests so the ~6 MB engine initializes
// only once per offscreen-document lifetime.
let workerPromise = null;
// One Tesseract worker is shared, so requests are serialized through this
// chain; `activeJobId` tags progress events with the job currently running.
let queue = Promise.resolve();
let activeJobId = null;

function getWorker() {
  if (workerPromise) return workerPromise;

  workerPromise = Tesseract.createWorker("eng", 1, {
    workerPath: chrome.runtime.getURL(`${VENDOR}/worker.min.js`),
    corePath: chrome.runtime.getURL(`${VENDOR}/${CORE_FILE}`),
    langPath: chrome.runtime.getURL(VENDOR),
    gzip: true,
    // MV3 CSP blocks blob: workers, so load the worker from the packaged file
    // and skip IndexedDB caching of the language data.
    workerBlobURL: false,
    cacheMethod: "none",
    logger: (m) => {
      if (m.status === "recognizing text" && activeJobId != null) {
        chrome.runtime.sendMessage({
          type: LassoMsg.OCR_PROGRESS,
          target: "background",
          jobId: activeJobId,
          progress: m.progress,
        });
      }
    },
  }).catch((err) => {
    // Reset so a later request can retry initialization.
    workerPromise = null;
    throw err;
  });

  return workerPromise;
}

async function runOcr(dataURL) {
  const worker = await getWorker();
  const { data } = await worker.recognize(dataURL, {}, { blocks: true });

  // Collect per-word boxes so the content script can lay each word over the
  // image at its real position. bbox is in recognized-image pixels.
  const words = [];
  const pushWord = (w) => {
    if (w?.text && w.text.trim() && w.bbox) {
      words.push({ text: w.text, bbox: w.bbox });
    }
  };
  if (Array.isArray(data.words) && data.words.length) {
    data.words.forEach(pushWord);
  } else {
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          (line.words || []).forEach(pushWord);
        }
      }
    }
  }

  return { text: (data.text || "").trim(), words };
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen" || msg.type !== LassoMsg.OCR_RUN) return;

  const { jobId, dataURL } = msg;
  // Serialize on the shared worker; every reply carries jobId so the background
  // routes it to the tab that requested it (no cross-tab leakage).
  queue = queue.then(async () => {
    activeJobId = jobId;
    try {
      const { text, words } = await runOcr(dataURL);
      chrome.runtime.sendMessage({
        type: LassoMsg.OCR_RESULT,
        target: "background",
        jobId,
        text,
        words,
      });
    } catch (err) {
      chrome.runtime.sendMessage({
        type: LassoMsg.OCR_ERROR,
        target: "background",
        jobId,
        message: err?.message || "Text recognition failed",
      });
    } finally {
      activeJobId = null;
    }
  });
});
