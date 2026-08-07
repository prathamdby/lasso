"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBrowserModule } = require("./load.js");

const { LassoGeometry: geo } = loadBrowserModule("geometry.js");

test("stitchCanvasFor allocates the growth allowance and reports uncapped", () => {
  // 4000 measured pads to 5000, then scales by dpr 2.
  assert.deepEqual(geo.stitchCanvasFor(4000, 800, 2, 800), {
    height: 10000,
    capped: false,
  });
});

test("stitchCanvasFor caps the allowance on very long pages", () => {
  assert.equal(geo.stitchCanvasFor(100000, 800, 1, 800).height, 32767);
});

test("stitchCanvasFor clamps to the max dimension", () => {
  const { height, capped } = geo.stitchCanvasFor(40000, 800, 1, 800);
  assert.equal(height, 32767);
  assert.equal(capped, true);
});

test("stitchCanvasFor clamps to the max area on wide pages", () => {
  const { height, capped } = geo.stitchCanvasFor(30000, 800, 1, 16384);
  assert.equal(height, 16384);
  assert.equal(capped, true);
});

test("stitchCanvasFor does not report capped when only the padding overflows", () => {
  // 30000 measured fits under 32767; its padded 36400 does not. The page is
  // intact, so this must not be flagged as truncated.
  const { height, capped } = geo.stitchCanvasFor(30000, 800, 1, 800);
  assert.equal(height, 32767);
  assert.equal(capped, false);
});

test("stitchCanvasFor rounds fractional dpr", () => {
  assert.equal(geo.stitchCanvasFor(1000, 0, 1.5, 800).height, 1500);
});

test("stitchCanvasFor skips padding when the viewport is unmeasurable", () => {
  assert.equal(geo.stitchCanvasFor(4000, 0, 1, 800).height, 4000);
});

test("sliceGeometry returns a full slice mid-page", () => {
  assert.deepEqual(geo.sliceGeometry(0, 800, 2400, 1), {
    destY: 0,
    srcHeight: 800,
  });
});

test("sliceGeometry trims the final short slice", () => {
  assert.deepEqual(geo.sliceGeometry(2000, 800, 2400, 1), {
    destY: 2000,
    srcHeight: 400,
  });
});

test("sliceGeometry scales both axes by dpr", () => {
  assert.deepEqual(geo.sliceGeometry(2000, 800, 2400, 2), {
    destY: 4000,
    srcHeight: 800,
  });
});

test("sliceGeometry yields an exact fit when the page is one viewport", () => {
  assert.deepEqual(geo.sliceGeometry(0, 800, 800, 1), {
    destY: 0,
    srcHeight: 800,
  });
});

test("cropRectForStitch passes a fully contained rect through unchanged", () => {
  const rect = { x: 10, y: 20, width: 100, height: 200 };
  assert.deepEqual(geo.cropRectForStitch(rect, 1000), rect);
});

test("cropRectForStitch clamps a rect overhanging the stitched area", () => {
  const rect = { x: 10, y: 900, width: 100, height: 200 };
  assert.deepEqual(geo.cropRectForStitch(rect, 1000), {
    x: 10,
    y: 900,
    width: 100,
    height: 100,
  });
});

test("cropRectForStitch throws when the rect starts below the capture", () => {
  assert.throws(
    () => geo.cropRectForStitch({ x: 0, y: 1200, width: 10, height: 10 }, 1000),
    /below the captured page area/,
  );
});

test("absoluteOffsetFor uses document coordinates without a container", () => {
  assert.deepEqual(geo.absoluteOffsetFor({ x: 40, y: 120 }, null, null), {
    top: 120,
    left: 40,
  });
});

test("absoluteOffsetFor subtracts the container origin and its border", () => {
  assert.deepEqual(
    geo.absoluteOffsetFor(
      { x: 40, y: 120 },
      { x: 10, y: 100 },
      { top: 2, left: 3 },
    ),
    { top: 18, left: 27 },
  );
});

test("treatmentFor pins a fixed navbar", () => {
  assert.equal(
    geo.treatmentFor("fixed", { x: 0, y: 0, width: 1280, height: 64 }, 1280, 800),
    "pin",
  );
});

test("treatmentFor releases a sticky header to its natural position", () => {
  assert.equal(
    geo.treatmentFor("sticky", { x: 0, y: 0, width: 1280, height: 64 }, 1280, 800),
    "release",
  );
});

test("treatmentFor releases a sticky sidebar regardless of its size", () => {
  assert.equal(
    geo.treatmentFor("sticky", { x: 0, y: 80, width: 240, height: 600 }, 1280, 800),
    "release",
  );
});

test("treatmentFor hides a full-viewport scrim", () => {
  assert.equal(
    geo.treatmentFor("fixed", { x: 0, y: 0, width: 1280, height: 800 }, 1280, 800),
    "hide",
  );
});

test("treatmentFor hides a bottom-anchored chat bubble", () => {
  assert.equal(
    geo.treatmentFor("fixed", { x: 1180, y: 720, width: 64, height: 64 }, 1280, 800),
    "hide",
  );
});

test("treatmentFor hides a bottom cookie bar", () => {
  assert.equal(
    geo.treatmentFor("fixed", { x: 0, y: 700, width: 1280, height: 100 }, 1280, 800),
    "hide",
  );
});

test("treatmentFor pins a tall top-anchored bar rather than reading it as floating", () => {
  assert.equal(
    geo.treatmentFor("fixed", { x: 0, y: 0, width: 200, height: 800 }, 1280, 800),
    "pin",
  );
});

test("treatmentFor pins a fixed element when the viewport is unmeasurable", () => {
  assert.equal(
    geo.treatmentFor("fixed", { x: 0, y: 0, width: 10, height: 10 }, 0, 0),
    "pin",
  );
});
