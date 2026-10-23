import test from "node:test";
import assert from "node:assert/strict";
import {
  planFaceRetry,
  mapRetryDetection,
  planImageFallback,
  decideImageFallback,
} from "../dist/face-retry.mjs";
const size = { width: 1000, height: 800 };
test("retry views are bounded and prioritise candidate crops without mutation", () => {
  const faces = [
    { score: 0.4, box: { x: 0.3, y: 0.2, width: 0.2, height: 0.3 } },
  ];
  const before = JSON.stringify(faces);
  const frames = planFaceRetry(size, faces);
  assert.equal(frames.length, 8);
  assert.equal(frames[0].cx, 400);
  assert.equal(JSON.stringify(faces), before);
  assert.equal(planFaceRetry(size, [...faces, ...faces, ...faces]).length, 12);
  assert.throws(() => planFaceRetry({ width: 10000, height: 10000 }, []));
});
test("retry inverse rotation maps to original coordinates and rejects off-image boxes", () => {
  const face = {
    score: 0.8,
    box: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 },
    eyes: [],
  };
  const result = mapRetryDetection(
    face,
    { cx: 500, cy: 400, side: 400, angle: Math.PI / 2 },
    size,
  );
  assert.ok(Math.abs(result.box.x - 0.46) < 1e-8);
  assert.ok(Math.abs(result.box.y - 0.45) < 1e-8);
  assert.equal(
    mapRetryDetection(face, { cx: -500, cy: 400, side: 400, angle: 0 }, size),
    null,
  );
  assert.equal(
    mapRetryDetection(
      { ...face, score: NaN },
      { cx: 500, cy: 400, side: 400, angle: 0 },
      size,
    ),
    null,
  );
});
test("fallback checks full image and four disjoint quarters, never claims a person detector", () => {
  const regions = planImageFallback(size);
  assert.equal(regions.length, 5);
  assert.deepEqual(regions[4], { x: 500, y: 400, width: 500, height: 400 });
  const yes = (directionDegrees) => ({
    decision: { verdict: "motion_suspected", directionDegrees },
  });
  assert.equal(
    decideImageFallback([yes(0), yes(0), {}]).verdict,
    "inconclusive",
  );
  assert.equal(
    decideImageFallback([{}, yes(0), yes(45)]).verdict,
    "inconclusive",
  );
  const result = decideImageFallback([{}, yes(45), yes(45)]);
  assert.deepEqual(result.reasons, ["image_motion"]);
  assert.equal(result.scope, "image_regions_not_confirmed_person");
});

test("completed motion checks are distinct from unavailable evidence", async () => {
  const { resolveReviewDecision } = await import("../dist/face-retry.mjs");
  const pending = {
    verdict: "inconclusive",
    issue: "focus_profile_unavailable",
  };
  const clean = {
    decision: { verdict: "no_signal" },
    assessment: { sufficient: true, sharpDetail: true },
  };
  assert.equal(resolveReviewDecision(pending, [clean]).verdict, "no_signal");
  assert.equal(resolveReviewDecision(pending, []), pending);
  assert.equal(
    resolveReviewDecision(pending, [
      clean,
      { decision: { verdict: "inconclusive" } },
    ]),
    pending,
  );
  const suspected = { verdict: "portrait_focus_suspected" };
  assert.equal(resolveReviewDecision(suspected, [clean]), suspected);
  const missing = { verdict: "inconclusive" };
  assert.equal(
    resolveReviewDecision(pending, [{ decision: missing }]),
    pending,
  );
});
test("all image regions must finish before reporting no signal", () => {
  const clean = {
    decision: { verdict: "no_signal" },
    assessment: { sufficient: true, sharpDetail: true },
  };
  assert.equal(decideImageFallback(Array(5).fill(clean)).verdict, "no_signal");
  assert.equal(
    decideImageFallback(Array(4).fill(clean)).verdict,
    "inconclusive",
  );
  assert.equal(
    decideImageFallback([
      clean,
      clean,
      clean,
      clean,
      { decision: { verdict: "inconclusive" } },
    ]).verdict,
    "inconclusive",
  );
});
