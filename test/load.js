"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// The extension's modules are browser IIFEs that publish onto `window`. Run one
// with `window` as a parameter so it populates a plain object, and so the values
// it returns are host-realm objects that compare normally. This exercises the
// same file the browser loads rather than a copy of its logic.
function loadBrowserModule(file) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  const load = new Function("window", `${source}\nreturn window;`);
  return load({});
}

module.exports = { loadBrowserModule };
