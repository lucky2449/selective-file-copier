import test from "node:test";
import assert from "node:assert/strict";
import {
  refineEyeContours,
  planFaceMotionCrops,
  medianDenoise,
} from "../dist/portrait-refinement.mjs";
const bounds = { width: 1000, height: 1000 },
  detection = {
    score: 0.9,
    box: { x: 0.2, y: 0.1, width: 0.5, height: 0.5 },
    eyes: [
      { x: 0.3, y: 0.4 },
      { x: 0.6, y: 0.4 },
    ],
  };
const ellipse = (x, y) =>
  Array.from({ length: 16 }, (_, i) => ({
    x: x + 0.03 * Math.cos((i * Math.PI) / 8),
    y: y + 0.01 * Math.sin((i * Math.PI) / 8),
  }));
test("eyelid contour geometry refines centres and keeps original descriptors unchanged", () => {
  const original = structuredClone(detection),
    r = refineEyeContours(
      detection,
      [ellipse(0.35, 0.3), ellipse(0.55, 0.3)],
      bounds,
    );
  assert.equal(r.eyesRefined, true);
  assert.ok(Math.abs(r.eyes[0].x - 0.35) < 1e-10);
  assert.ok(r.eyeSides.every((v) => v >= 64 && v <= 256));
  assert.deepEqual(detection, original);
});
test("missing, off-image, closed or overlapping eye contours cannot be called verified", () => {
  for (const contours of [
    [],
    [ellipse(0.35, 0.3)],
    [ellipse(0.35, 0.3), ellipse(0.35, 0.3)],
    [ellipse(-0.1, 0.3), ellipse(0.55, 0.3)],
    [ellipse(0.35, 0.3).map((p) => ({ ...p, y: 0.3 })), ellipse(0.55, 0.3)],
  ])
    assert.equal(refineEyeContours(detection, contours, bounds), null);
  assert.equal(
    refineEyeContours(detection, [ellipse(0.35, 0.3), ellipse(0.55, 0.3)], {
      width: Infinity,
      height: 1000,
    }),
    null,
  );
});
function image(width = 64, height = 64) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = i % width < width / 2 ? 40 : 200;
    data.set([v, v, v, 255], i * 4);
  }
  return { width, height, data };
}
test("median denoising removes impulse noise but keeps a strong edge and source bytes", () => {
  const input = image();
  input.data.set([255, 255, 255, 255], (20 * 64 + 10) * 4);
  const before = input.data.slice();
  const result = medianDenoise(input);
  assert.deepEqual(input.data, before);
  assert.equal(result.image.data[(20 * 64 + 10) * 4], 40);
  assert.equal(result.image.data[(20 * 64 + 40) * 4], 200);
  assert.ok(result.meanAbsoluteResidual > 0);
});
test("denoising is bounded, opaque-only and abortable", () => {
  const input = image();
  const abort = new AbortController();
  abort.abort();
  assert.throws(() => medianDenoise(input, { signal: abort.signal }), {
    name: "AbortError",
  });
  input.data[3] = 0;
  assert.throws(() => medianDenoise(input), TypeError);
  assert.throws(
    () =>
      medianDenoise({
        width: 1000,
        height: 1000,
        data: new Uint8ClampedArray(4),
      }),
    TypeError,
  );
});

test("median filtering preserves selected source RGB rather than adding grayscale rounding noise", () => {
  const input = image();
  for (let i = 0; i < input.data.length; i += 4)
    input.data.set([123, 34, 45, 255], i);
  const result = medianDenoise(input);
  assert.deepEqual(result.image.data, input.data);
  assert.equal(result.meanAbsoluteResidual, 0);
});

test("face motion crops remain available when eye geometry is unreliable", () => {
  const detections = [{ ...detection, eyes: [], eyesRefined: false }];
  const before = structuredClone(detections),
    crops = planFaceMotionCrops(bounds, detections);
  assert.equal(crops.length, 1);
  assert.ok(crops[0].rect.width <= 768);
  assert.deepEqual(detections, before);
  assert.equal(
    planFaceMotionCrops(bounds, [
      { score: 0.9, box: { x: -1, y: 0, width: 0.2, height: 0.2 } },
    ]).length,
    0,
  );
  assert.throws(
    () => planFaceMotionCrops(bounds, Array(257).fill(detection)),
    TypeError,
  );
});
