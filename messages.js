const LassoMsg = Object.freeze({
  CAPTURE: "capture",
  OPEN_PREVIEW: "openPreview",
  DOWNLOAD: "download",
  CANCEL_CAPTURE: "cancelCapture",
  SELECTION_CAPTURE: "selectionCapture",
  GET_PAGE_DIMENSIONS: "getPageDimensions",
  SCROLL_TO: "scrollTo",
  START_SELECTION: "startSelection",
  START_PREVIEW: "startPreview",
  PREPARE_CAPTURE: "prepareCapture",
  GET_CAPTURE_PARAMS: "getCaptureParams",
  CROP: "crop",
  STITCH: "stitch",
  HIDE_FIXED_ELEMENTS: "hideFixedElements",
  RESTORE_FIXED_ELEMENTS: "restoreFixedElements",
  CAPTURE_CANCELLED: "captureCancelled",
  CAPTURE_FAILED: "captureFailed",
  // Content → background request to extract text from a captured image via
  // Gemini. Background answers on the same channel with { ok, text } or
  // { ok: false, code, message }, so no separate result/error messages needed.
  EXTRACT_TEXT: "extractText",
});
