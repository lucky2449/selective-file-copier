import test from "node:test";
import assert from "node:assert/strict";
import { assessDetailEvidence } from "../dist/detail-evidence.mjs";
import {
  resolveReviewDecision,
  decideImageFallback,
} from "../dist/face-retry.mjs";
const evidence = () => ({
  version: "face-edge-profiles-v1",
  scales: [0, 1].map(() => ({
    detail: { laplacianVariance: 20, tenengrad: 30 },
    detailRegions: Array.from({ length: 9 }, () => ({
      pixels: 1000,
      laplacianVariance: 20,
      tenengrad: 30,
    })),
    bins: [],
  })),
});
test("sharp spatial detail does not require directional motion edges", () => {
  assert.equal(assessDetailEvidence(evidence()).sharpDetail, true);
});
test("only one detailed patch or mismatched scale patches cannot establish sharp detail", () => {
  const e = evidence();
  e.scales.forEach((s) =>
    s.detailRegions.forEach((r, i) => {
      if (i > 0) r.tenengrad = 0;
    }),
  );
  assert.equal(assessDetailEvidence(e).sharpDetail, false);
  const mismatch = evidence();
  mismatch.scales.forEach((s, j) =>
    s.detailRegions.forEach((r, i) => {
      if (j ? i < 5 : i > 3) r.tenengrad = 0;
    }),
  );
  assert.equal(assessDetailEvidence(mismatch).sharpDetail, false);
});
test("flat or weak detail remains withheld without labelling it motion", () => {
  const e = evidence();
  e.scales.forEach((s) => {
    s.detail.tenengrad = 0;
    s.detailRegions.forEach((r) => (r.tenengrad = 0));
  });
  const assessment = assessDetailEvidence(e);
  assert.equal(assessment.sufficient, true);
  assert.equal(assessment.sharpDetail, false);
  const pending = { verdict: "inconclusive" };
  assert.equal(
    resolveReviewDecision(pending, [
      { decision: { verdict: "no_signal" }, assessment },
    ]),
    pending,
  );
});
test("missing, nonfinite and undersampled spatial measurements fail closed", () => {
  assert.equal(assessDetailEvidence(null).sufficient, false);
  for (const change of [
    (e) => delete e.scales[0].detailRegions,
    (e) => (e.scales[1].detailRegions[0].pixels = 0),
    (e) => (e.scales[0].detail.laplacianVariance = NaN),
  ]) {
    const e = evidence();
    change(e);
    assert.equal(assessDetailEvidence(e).sufficient, false);
  }
});
test("landscape/animal route needs two detailed samples and preserves motion precedence", () => {
  const good = {
    decision: { verdict: "no_signal" },
    assessment: assessDetailEvidence(evidence()),
  };
  const weak = {
    decision: { verdict: "no_signal" },
    assessment: { sufficient: false, sharpDetail: false },
  };
  assert.equal(
    decideImageFallback([good, good, weak, weak, weak]).verdict,
    "inconclusive",
  );
  assert.equal(
    decideImageFallback([weak, good, good, weak, weak]).verdict,
    "no_signal",
  );
  const suspect = { verdict: "motion_suspected" };
  assert.equal(resolveReviewDecision(suspect, [good]), suspect);
});
test("detail assessment leaves measurement buffers and motion evidence unchanged", () => {
  const e = evidence(),
    before = JSON.stringify(e);
  assessDetailEvidence(e);
  assert.equal(JSON.stringify(e), before);
});
