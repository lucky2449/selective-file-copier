import test from "node:test";
import assert from "node:assert/strict";
import { reviewPhotos, qualityStatus } from "../dist/quality-review.mjs";
import { createReviewStore, needsAttention } from "../dist/photo-review.mjs";
const entry = (name) => ({
  name,
  path: name,
  file: new Blob(["untouched-original"]),
});
test("review batch keeps selection/bytes, deduplicates entries and maps withheld results honestly", async () => {
  const store = createReviewStore(),
    jpg = entry("one.JPG"),
    raw = entry("one.CR3"),
    rows = [jpg, raw].map((chosen) =>
      store.bind({ chosen, selected: true, candidates: [chosen] }),
    );
  let calls = 0;
  const totals = await reviewPhotos({
    entries: [jpg, jpg, raw],
    store,
    reviewer: {
      async analyze() {
        calls++;
        return { decision: { verdict: "inconclusive" } };
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(totals.inconclusive, 1);
  assert.equal(totals.unsupported, 1);
  assert.ok(rows.every((r) => r.selected && !needsAttention(r)));
  assert.equal(await jpg.file.text(), "untouched-original");
});
test("suspected motion joins attention; worker failures do not stop remaining JPGs", async () => {
  const store = createReviewStore(),
    entries = [entry("fail.jpg"), entry("motion.jpg")];
  const rows = entries.map((chosen) =>
    store.bind({ chosen, selected: true, candidates: [chosen] }),
  );
  let calls = 0;
  const totals = await reviewPhotos({
    entries,
    store,
    reviewer: {
      async analyze() {
        if (!calls++) throw Error();
        return {
          decision: { verdict: "motion_suspected", reasons: ["motion"] },
        };
      },
    },
  });
  assert.equal(totals.failed, 1);
  assert.equal(totals.complete, 1);
  assert.equal(needsAttention(rows[0]), false);
  assert.equal(needsAttention(rows[1]), true);
  assert.ok(rows.every((r) => r.selected));
  assert.equal(qualityStatus({}).status, "inconclusive");
});
test("cancelling aborts current analysis and leaves unstarted photos unanalysed", async () => {
  const store = createReviewStore(),
    controller = new AbortController(),
    entries = [entry("one.jpg"), entry("two.jpg")];
  const totals = await reviewPhotos({
    entries,
    store,
    signal: controller.signal,
    reviewer: {
      async analyze() {
        controller.abort();
        throw new DOMException("Cancelled", "AbortError");
      },
    },
  });
  assert.equal(totals.cancelled, 1);
  assert.equal(store.read(entries[0]).status, "cancelled");
  assert.equal(store.read(entries[1]).status, "unanalysed");
});

test("JPG batch supplies the pilot motion profile without changing input entries", async () => {
  const store = createReviewStore(),
    jpg = entry("face.jpg");
  let received;
  await reviewPhotos({
    entries: [jpg],
    store,
    reviewer: {
      async analyze(file, options) {
        assert.equal(file, jpg.file);
        received = options.motionProfile;
        return { decision: { verdict: "inconclusive" } };
      },
    },
  });
  assert.equal(received.version, "face-edge-profiles-v1");
  assert.ok(Object.isFrozen(received));
  assert.equal(received.maxLaplacian, 2);
});
