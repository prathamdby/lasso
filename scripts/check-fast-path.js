#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const failures = [];

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function scanLines(file, checks) {
  read(file)
    .split("\n")
    .forEach((line, index) => {
      for (const check of checks) {
        if (!check.regex.test(line)) continue;
        if (check.allow?.some((allow) => allow.test(line))) continue;
        failures.push(`${file}:${index + 1} ${check.reason}: ${line.trim()}`);
      }
    });
}

for (const file of ["content.css", "popup.css"]) {
  scanLines(file, [
    {
      regex: /\btransition(?:-[a-z]+)?\b/i,
      reason: "CSS transition is disabled",
    },
    {
      regex: /\banimation(?:-[a-z]+)?\b/i,
      reason: "CSS animation is disabled",
    },
    { regex: /@keyframes/i, reason: "CSS keyframes are disabled" },
  ]);
}

for (const file of [
  "background.js",
  "content.js",
  "selection-ui.js",
  "capture-pipeline.js",
  "fixed-elements.js",
  "hotkey.js",
  "popup.js",
]) {
  scanLines(file, [
    { regex: /\bsetInterval\s*\(/, reason: "interval is disabled" },
    {
      regex: /\bsetTimeout\s*\(/,
      reason: "fixed timeout is disabled",
      allow: [/setTimeout\(\(\) => notice\.remove\(\), 4000\)/],
    },
    { regex: /\bfunction\s+delay\s*\(/, reason: "delay helper is disabled" },
    {
      regex: /\b(?:SCROLL_WAIT_MS|PICK_SCROLL_WAIT_MS)\b/,
      reason: "fixed scroll wait is disabled",
    },
  ]);
}

const background = read("background.js");
const content = read("content.js");

function requireMatch(file, regex, reason) {
  if (!regex.test(read(file))) failures.push(`${file} ${reason}`);
}

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  if (start === -1) return "";
  const end = source.indexOf(endText, start + startText.length);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

requireMatch(
  "background.js",
  /async function prepareTabForCapture\(tabId\)[\s\S]*LassoMsg\.PREPARE_CAPTURE[\s\S]*Capture preparation failed/,
  "must keep awaited capture preparation",
);
const prepareCase = sliceBetween(
  content,
  "case LassoMsg.PREPARE_CAPTURE:",
  "case LassoMsg.GET_CAPTURE_PARAMS:",
);
if (
  !/prepareCaptureChrome\(\)/.test(prepareCase) ||
  !/return true;/.test(prepareCase)
) {
  failures.push("content.js must keep async PREPARE_CAPTURE response");
}
requireMatch(
  "selection-ui.js",
  /function waitForPaint\(\)[\s\S]*requestAnimationFrame[\s\S]*requestAnimationFrame/,
  "must keep double paint wait",
);
requireMatch(
  "selection-ui.js",
  /async function prepareCaptureChrome\(\)[\s\S]*hideCaptureChrome\(\);\s*await waitForPaint\(\);/,
  "must hide capture chrome before paint wait",
);

const visibleCaptureIndex = background.indexOf(
  "const dataURL = await chrome.tabs.captureVisibleTab",
);
const visiblePrepareIndex = background.indexOf("await prepareTabForCapture(tabId);");
if (visiblePrepareIndex === -1 || visiblePrepareIndex > visibleCaptureIndex) {
  failures.push("background.js must prepare tab before visible capture");
}

const fullPageIndex = background.indexOf("async function captureFullPage");
const fullPagePrepareIndex = background.indexOf(
  "await prepareTabForCapture(tab.id);",
  fullPageIndex,
);
const fullPageCaptureIndex = background.indexOf(
  "const dataURL = await chrome.tabs.captureVisibleTab",
  fullPageIndex,
);
if (fullPagePrepareIndex === -1 || fullPagePrepareIndex > fullPageCaptureIndex) {
  failures.push("background.js must prepare tab before full-page capture");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("fast-path checks passed");
