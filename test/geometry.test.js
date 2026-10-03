"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBrowserModule } = require("./load.js");

const { LassoGeometry: geo } = loadBrowserModule("geometry.js");

test("stitchCanvasFor allocates the growth allowance", () => {
  // 4000 measured pads to 5000, then scales by dpr 2.
  assert.equal(geo.stitchCanvasFor(4000, 800, 2, 800), 10000);
});

test("stitchCanvasFor caps the allowance on very long pages", () => {
  assert.equal(geo.stitchCanvasFor(100000, 800, 1, 800), 32767);
});

test("stitchCanvasFor clamps to the max dimension", () => {
  assert.equal(geo.stitchCanvasFor(40000, 800, 1, 800), 32767);
});

test("stitchCanvasFor clamps to the max area on wide pages", () => {
  assert.equal(geo.stitchCanvasFor(30000, 800, 1, 16384), 16384);
});

test("stitchCanvasFor applies the growth allowance at fractional dpr", () => {
  // 1001 pads to 1251, then scales by 1.5 and rounds.
  assert.equal(geo.stitchCanvasFor(1001, 800, 1.5, 800), 1877);
});

test("stitchCanvasFor applies the area cap after fractional dpr scaling", () => {
  // Padded 36400 scales to 54600, above the 22369 area cap for this width.
  assert.equal(geo.stitchCanvasFor(30000, 800, 1.5, 12000), 22369);
});

test("stitchCanvasFor rounds fractional dpr", () => {
  assert.equal(geo.stitchCanvasFor(1000, 0, 1.5, 800), 1500);
});

test("stitchCanvasFor skips padding when the viewport is unmeasurable", () => {
  assert.equal(geo.stitchCanvasFor(4000, 0, 1, 800), 4000);
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

// A fixed element whose top edge sits exactly at mid-viewport and whose bottom
// touches the viewport bottom stays pinned. Hiding deletes content silently,
// pinning leaves it visible and obvious, so the tie goes to pinning.
test("treatmentFor pins an element whose top edge sits exactly at mid-viewport", () => {
  assert.equal(
    geo.treatmentFor("fixed", { x: 0, y: 400, width: 1280, height: 400 }, 1280, 800),
    "pin",
  );
});

test("treatmentFor hides an element one pixel below mid-viewport", () => {
  assert.equal(
    geo.treatmentFor("fixed", { x: 0, y: 401, width: 1280, height: 399 }, 1280, 800),
    "hide",
  );
});

test("establishesContainingBlock accepts a positioned ancestor", () => {
  assert.equal(geo.establishesContainingBlock({ position: "relative" }), true);
});

test("establishesContainingBlock rejects a plain static ancestor", () => {
  assert.equal(
    geo.establishesContainingBlock({
      position: "static",
      transform: "none",
      filter: "none",
      perspective: "none",
      contain: "none",
      willChange: "auto",
    }),
    false,
  );
});

test("establishesContainingBlock accepts each containment keyword", () => {
  for (const value of ["layout", "paint", "strict", "content"]) {
    assert.equal(
      geo.establishesContainingBlock({ position: "static", contain: value }),
      true,
      `contain: ${value}`,
    );
  }
});

test("establishesContainingBlock accepts contain shorthand combinations", () => {
  assert.equal(
    geo.establishesContainingBlock({ position: "static", contain: "size layout" }),
    true,
  );
});

test("establishesContainingBlock rejects size-only containment", () => {
  // `contain: size` alone does not establish a containing block.
  assert.equal(
    geo.establishesContainingBlock({ position: "static", contain: "size" }),
    false,
  );
});

test("establishesContainingBlock accepts backdrop-filter", () => {
  assert.equal(
    geo.establishesContainingBlock({
      position: "static",
      backdropFilter: "blur(4px)",
    }),
    true,
  );
});

test("establishesContainingBlock accepts a container-type ancestor", () => {
  assert.equal(
    geo.establishesContainingBlock({
      position: "static",
      containerType: "inline-size",
    }),
    true,
  );
});

test("resizeRect grows from the dragged corner by default", () => {
  assert.deepEqual(
    geo.resizeRect({ x: 100, y: 100, width: 200, height: 100 }, "se", 40, 20),
    { x: 100, y: 100, width: 240, height: 120 },
  );
});

test("resizeRect keeps the opposite corner fixed when dragging north-west", () => {
  assert.deepEqual(
    geo.resizeRect({ x: 100, y: 100, width: 200, height: 100 }, "nw", -20, -10),
    { x: 80, y: 90, width: 220, height: 110 },
  );
});

test("resizeRect uses Alt to grow symmetrically from the center", () => {
  assert.deepEqual(
    geo.resizeRect({ x: 100, y: 100, width: 200, height: 100 }, "se", 20, 10, { centered: true }),
    { x: 80, y: 90, width: 240, height: 120 },
  );
});

test("resizeRect uses Shift to preserve the starting aspect ratio", () => {
  assert.deepEqual(
    geo.resizeRect({ x: 100, y: 100, width: 200, height: 100 }, "e", 40, 0, { preserveAspect: true }),
    { x: 100, y: 90, width: 240, height: 120 },
  );
});

test("resizeRect combines Alt and Shift", () => {
  assert.deepEqual(
    geo.resizeRect({ x: 100, y: 100, width: 200, height: 100 }, "se", 20, 10, { centered: true, preserveAspect: true }),
    { x: 80, y: 90, width: 240, height: 120 },
  );
});

test("resizeRect projects corner Shift movement onto the starting aspect ratio", () => {
  assert.deepEqual(
    geo.resizeRect(
      { x: 100, y: 100, width: 200, height: 100 },
      "se",
      40,
      10,
      { preserveAspect: true },
    ),
    { x: 100, y: 100, width: 240, height: 120 },
  );
});

test("resizeRect preserves a right-edge anchor while resizing without modifiers", () => {
  assert.deepEqual(
    geo.resizeRect(
      { x: 100, y: 100, width: 200, height: 100 },
      "w",
      -20,
      0,
      { bounds: { width: 1000, height: 800 } },
    ),
    { x: 80, y: 100, width: 220, height: 100 },
  );
});

test("resizeRect caps a centered resize at the viewport edge", () => {
  assert.deepEqual(
    geo.resizeRect(
      { x: 100, y: 100, width: 200, height: 100 },
      "se",
      1000,
      1000,
      { centered: true, bounds: { width: 500, height: 400 } },
    ),
    { x: 0, y: 0, width: 400, height: 300 },
  );
});

test("establishesContainingBlock accepts transform, filter and perspective", () => {
  assert.equal(geo.establishesContainingBlock({ transform: "translateY(4px)" }), true);
  assert.equal(geo.establishesContainingBlock({ filter: "blur(2px)" }), true);
  assert.equal(geo.establishesContainingBlock({ perspective: "400px" }), true);
});

test("establishesContainingBlock reads will-change hints", () => {
  assert.equal(
    geo.establishesContainingBlock({ position: "static", willChange: "transform" }),
    true,
  );
  assert.equal(
    geo.establishesContainingBlock({ position: "static", willChange: "opacity" }),
    false,
  );
});

test("stitchCanvasFor skips the growth allowance with a fixed height", () => {
  assert.equal(
    geo.stitchCanvasFor(4000, 800, 2, 800, { fixedHeight: true }),
    8000,
  );
});

test("stitchCanvasFor still clamps a fixed height to the max dimension", () => {
  assert.equal(
    geo.stitchCanvasFor(40000, 800, 1, 800, { fixedHeight: true }),
    32767,
  );
});

test("treatmentFor hides a fixed element first seen after scrolling", () => {
  assert.equal(
    geo.treatmentFor(
      "fixed",
      { x: 0, y: 0, width: 1280, height: 64 },
      1280,
      800,
      { seenScrolled: true },
    ),
    "hide",
  );
});

test("treatmentFor still releases a sticky element seen after scrolling", () => {
  assert.equal(
    geo.treatmentFor(
      "sticky",
      { x: 0, y: 0, width: 1280, height: 64 },
      1280,
      800,
      { seenScrolled: true },
    ),
    "release",
  );
});

test("treatmentFor pins a fixed navbar when not seen after scrolling", () => {
  assert.equal(
    geo.treatmentFor(
      "fixed",
      { x: 0, y: 0, width: 1280, height: 64 },
      1280,
      800,
      { seenScrolled: false },
    ),
    "pin",
  );
});

function assertWholePixelChunks(chunks, dpr, maxDevicePx) {
  for (const { y, height } of chunks) {
    const deviceY = y * dpr;
    const deviceHeight = height * dpr;
    assert.ok(Math.abs(deviceY - Math.round(deviceY)) < 1e-6, `y ${y}`);
    assert.ok(
      Math.abs(deviceHeight - Math.round(deviceHeight)) < 1e-6,
      `height ${height}`,
    );
    assert.ok(deviceHeight <= maxDevicePx + 1e-6, `height ${height} too tall`);
  }
}

test("screenshotChunks splits a page into contiguous chunks at dpr 1", () => {
  const chunks = geo.screenshotChunks(20000, 1);
  assert.deepEqual(chunks, [
    { y: 0, height: 8192 },
    { y: 8192, height: 8192 },
    { y: 16384, height: 3616 },
  ]);
});

test("screenshotChunks halves the chunk height at dpr 2", () => {
  const chunks = geo.screenshotChunks(10000, 2);
  assert.deepEqual(chunks, [
    { y: 0, height: 4096 },
    { y: 4096, height: 4096 },
    { y: 8192, height: 1808 },
  ]);
});

test("screenshotChunks returns one chunk for a short page", () => {
  assert.deepEqual(geo.screenshotChunks(900, 1), [{ y: 0, height: 900 }]);
});

for (const dpr of [1, 1.25, 1.5, 1.75, 2]) {
  test(`screenshotChunks keeps whole device pixels at dpr ${dpr}`, () => {
    const chunks = geo.screenshotChunks(23456, dpr);
    assertWholePixelChunks(chunks, dpr, 8192);

    for (let i = 1; i < chunks.length; i += 1) {
      assert.equal(chunks[i].y, chunks[i - 1].y + chunks[i - 1].height);
    }
    const last = chunks[chunks.length - 1];
    assert.ok(last.y + last.height >= 23456);
    assert.ok(last.y + last.height < 23456 + 4);
  });
}

test("screenshotChunks uses 4px steps at dpr 1.25", () => {
  const [first] = geo.screenshotChunks(10000, 1.25);
  assert.equal(first.height % 4, 0);
  assert.equal(first.height, 6552);
});

test("screenshotChunks caps the total at the canvas limits", () => {
  const chunks = geo.screenshotChunks(100000, 1, 8192, 800);
  const last = chunks[chunks.length - 1];
  assert.ok(last.y + last.height <= 32767);
  assert.ok(last.y + last.height > 32000);
});

test("screenshotChunks caps the total by canvas area on wide pages", () => {
  const chunks = geo.screenshotChunks(30000, 1, 8192, 16384);
  const last = chunks[chunks.length - 1];
  assert.equal(last.y + last.height, 16384);
});

test("screenshotChunks returns nothing for an empty page", () => {
  assert.deepEqual(geo.screenshotChunks(0, 1), []);
});

test("viewportSizedIndices finds elements that grew with the viewport", () => {
  assert.deepEqual(
    geo.viewportSizedIndices([800, 64, 400], [900, 64, 450], 100),
    [0, 2],
  );
});

test("viewportSizedIndices ignores reflow larger than the viewport change", () => {
  assert.deepEqual(geo.viewportSizedIndices([300], [700], 100), []);
});

test("viewportSizedIndices ignores unmeasurable entries", () => {
  assert.deepEqual(geo.viewportSizedIndices([null, 800], [900, 900], 100), [1]);
});
