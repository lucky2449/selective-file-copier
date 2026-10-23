import test from "node:test";
import assert from "node:assert/strict";
import { createReviewStore, needsAttention, appendReviewBadge } from "../dist/photo-review.mjs";
import { resultFilterCounts, matchesResultFilter } from "../dist/result-filter.mjs";
import { selectedFiles } from "../dist/core.mjs";

function fixture() {
  const store = createReviewStore();
  const file = { name: "one.JPG", path: "source/one.JPG", file: new Blob(["original"]) };
  const row = store.bind({ item: "one", chosen: file, candidates: [file], selected: true });
  const finish = (reasons = ["blur"], status = "complete") => store.finish(file, store.begin(file), { status, reasons });
  return { store, file, row, finish };
}
test("unanalysed, analysing, failed and unsupported do not claim clean or require quality review", () => {
  const { store, file, row } = fixture();
  assert.equal(row.review.status, "unanalysed");
  assert.equal(needsAttention(row), false);
  for (const status of ["failed", "unsupported", "complete"]) {
    const token = store.begin(file);
    assert.equal(row.review.status, "analysing");
    assert.equal(needsAttention(row), false);
    store.finish(file, token, { status, reasons: [] });
    assert.equal(needsAttention(row), false);
  }
});
test("review and matching attention overlap found without double counting reasons", () => {
  const { row, finish } = fixture(); finish(["blur", "eyes_closed", "blur"]);
  const unresolved = { chosen: null, candidates: [{}, {}], selected: false };
  const missing = { chosen: null, candidates: [], selected: false };
  assert.deepEqual(row.review.reasons, ["blur", "eyes_closed"]);
  assert.deepEqual(resultFilterCounts([row, unresolved, missing]), { all: 3, found: 1, attention: 2, missing: 1, selected: 1 });
  assert.equal(matchesResultFilter(row, "attention"), true);
});
test("confirmation shares by file identity, preserves choices and keeps unresolved attention", () => {
  const { store, row, file, finish } = fixture(); finish();
  const duplicate = store.bind({ ...row });
  const unresolved = store.bind({ item: "dup", chosen: null, candidates: [file], selected: false });
  const before = selectedFiles([row, duplicate]);
  store.acknowledge(file);
  assert.equal(needsAttention(row), false);
  assert.equal(needsAttention(duplicate), false);
  assert.equal(needsAttention(unresolved), true);
  assert.deepEqual(selectedFiles([row, duplicate]), before);
  assert.equal(row.selected, true);
  assert.equal(duplicate.selected, true);
});
test("candidate replacement follows new file; same path in a new source does not inherit approval", () => {
  const { store, row, file, finish } = fixture(); finish(); store.acknowledge(file);
  const second = { ...file };
  row.chosen = second;
  assert.equal(row.review.status, "unanalysed");
  store.finish(second, store.begin(second), { status: "complete", reasons: ["similar"] });
  assert.equal(needsAttention(row), true);
  row.chosen = file;
  assert.equal(row.review.acknowledged, true);
});
test("reset and newer runs reject stale or repeated completions and new results revoke prior acknowledgement", () => {
  const { store, file, row, finish } = fixture(); finish(); store.acknowledge(file);
  const old = store.begin(file), current = store.begin(file);
  assert.equal(store.finish(file, old, { status: "complete", reasons: ["blur"] }), false);
  assert.equal(store.finish(file, current, { status: "complete", reasons: ["blur"] }), true);
  assert.equal(needsAttention(row), true);
  assert.equal(store.finish(file, current, { status: "complete", reasons: [] }), false);
  const pending = store.begin(file); store.clear();
  assert.equal(store.finish(file, pending, { status: "complete", reasons: ["blur"] }), false);
  assert.equal(row.review.status, "unanalysed");
});
test("unknown reasons and raw error details are dropped; snapshots are immutable", () => {
  const { row, file, store } = fixture();
  const result = { status: "complete", reasons: ["<img onerror=evil()>", "blur", "__proto__"], message: "private/path.JPG" };
  store.finish(file, store.begin(file), result);
  result.reasons.push("eyes_closed");
  assert.deepEqual(row.review, { status: "complete", reasons: ["blur"], acknowledged: false });
  assert.throws(() => row.review.reasons.push("similar"));
});
test("review processing never calls file write, move or delete methods or reads photo contents", () => {
  const { store, row, file } = fixture();
  for (const method of ["createWritable", "remove", "move", "arrayBuffer", "stream"])
    file[method] = () => assert.fail(method + " must not be called");
  store.finish(file, store.begin(file), { status: "complete", reasons: ["blur"] });
  store.acknowledge(file); needsAttention(row); store.clear();
  assert.equal(row.chosen, file); assert.equal(row.selected, true);
});

class Element {
  children = []; attributes = {}; handlers = {};
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
}
const document = { createElement(tag) { return Object.assign(new Element(), { tag }); } };
function badge(row, options = {}) {
  const content = new Element();
  appendReviewBadge({ document, row, content, ...options });
  return content;
}
test("real UI shows neutral unanalysed state and no badge for missing/ambiguous rows", () => {
  const { row } = fixture();
  assert.equal(badge(row).children[0].children[0].textContent, "미분석");
  assert.equal(badge({ chosen: null }).children.length, 0);
});
test("badge details use allowed text only and block acknowledgement while busy", () => {
  const { row, finish } = fixture(); finish(["blur", "eyes_closed", "<script>"]);
  row.item = '<img src="x" onerror="evil()">';
  let busy = true, acknowledged = 0;
  const detail = badge(row, { disabled: true, isBusy: () => busy, onAcknowledge: () => acknowledged++ }).children[0].children[0];
  const [summary, explanation, button] = detail.children;
  assert.equal(summary.textContent, "흐림 의심 · 눈 감음 의심");
  assert.ok(!explanation.textContent.includes("<script>"));
  assert.equal(button.disabled, true);
  button.handlers.click(); assert.equal(acknowledged, 0);
  busy = false; button.handlers.click(); assert.equal(acknowledged, 1);
  assert.equal(row.selected, true);
});
test("confirmation rerender removes quality attention while hidden selected files remain in output", () => {
  const { row, store, file, finish } = fixture(); finish();
  const [detail] = badge(row, { onAcknowledge: () => store.acknowledge(file) }).children[0].children;
  detail.children[2].handlers.click();
  assert.equal(badge(row).children[0].children[0].textContent, "검토 확인 완료");
  assert.equal([row].filter(r => matchesResultFilter(r, "attention")).length, 0);
  assert.deepEqual(selectedFiles([row]), [file]);
});
