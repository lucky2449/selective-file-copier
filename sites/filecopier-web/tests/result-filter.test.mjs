import test from "node:test";
import assert from "node:assert/strict";
import {
  matchesResultFilter,
  resultFilterCounts,
} from "../dist/result-filter.mjs";
test("filters partition resolved, ambiguous, missing requests without modifying selection", () => {
  const found = { chosen: { path: "A.JPG" }, candidates: [{}], selected: true };
  const unchecked = {
    chosen: { path: "B.JPG" },
    candidates: [{}],
    selected: false,
  };
  const ambiguous = { chosen: null, candidates: [{}, {}], selected: false };
  const missing = { chosen: null, candidates: [], selected: false };
  const rows = [found, unchecked, ambiguous, missing],
    before = structuredClone(rows);
  assert.deepEqual(resultFilterCounts(rows), {
    all: 4,
    found: 2,
    attention: 1,
    missing: 1,
    selected: 1,
  });
  assert.deepEqual(
    rows.filter((r) => matchesResultFilter(r, "attention")),
    [ambiguous],
  );
  assert.deepEqual(
    rows.filter((r) => matchesResultFilter(r, "selected")),
    [found],
  );
  assert.deepEqual(rows, before);
  ambiguous.chosen = { path: "candidate.JPG" };
  ambiguous.selected = true;
  assert.deepEqual(resultFilterCounts(rows), {
    all: 4,
    found: 3,
    attention: 0,
    missing: 1,
    selected: 2,
  });
});
