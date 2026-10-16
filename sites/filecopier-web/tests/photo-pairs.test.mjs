import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIndex,
  matchItem,
  selectedFiles,
} from "../dist/core.mjs?v=raw-jpg-1";
import {
  buildPhotoPairs,
  expandPhotoPairs,
  resolvePhotoPair,
} from "../dist/photo-pairs.mjs";
const file = (path) => Object.freeze({ path, name: path.split("/").at(-1) });

test("pairing preserves originals, includes RAW and JPEG variants, and deduplicates", () => {
  const files = [
    "a/IMG_0001.JPG",
    "a/IMG_0001.CR3",
    "a/IMG_0001.DNG",
    "a/IMG_0001.jpeg",
  ].map(file);
  const snapshot = JSON.stringify(files);
  const pairs = buildPhotoPairs(files);
  assert.deepEqual(
    new Set(expandPhotoPairs([files[0], files[1]], pairs)),
    new Set(files),
  );
  assert.deepEqual(
    new Set(expandPhotoPairs([files[1]], pairs)),
    new Set(files),
  );
  assert.equal(JSON.stringify(files), snapshot);
});
test("same number, different folders or stems, sidecars and videos are never paired", () => {
  const files = [
    "a/IMG_0001.jpg",
    "b/IMG_0001.cr3",
    "a/DSC0001.nef",
    "a/IMG_0001.xmp",
    "a/IMG_0001.mp4",
    "a/IMG_0001.jpg.Zone.Identifier",
    "a/IMG_0001-edit.cr3",
  ].map(file);
  assert.deepEqual(expandPhotoPairs([files[0]], buildPhotoPairs(files)), [
    files[0],
  ]);
});
test("case insensitive names pair within a folder; lone RAW/JPG stay alone", () => {
  const files = [
    "a/IMG_0001.JPG",
    "a/img_0001.NEF",
    "a/IMG_0002.JPG",
    "a/IMG_0003.ARW",
  ].map(file);
  const pairs = buildPhotoPairs(files);
  assert.deepEqual(expandPhotoPairs([files[0]], pairs), files.slice(0, 2));
  assert.deepEqual(expandPhotoPairs(files.slice(2), pairs), files.slice(2));
});
test("numeric pair resolves together but cross folder collisions require explicit selection", () => {
  const files = [
    "a/IMG_0001.jpg",
    "a/IMG_0001.cr3",
    "b/IMG_0001.jpg",
    "b/IMG_0001.cr3",
  ].map(file);
  const pairs = buildPhotoPairs(files);
  const single = resolvePhotoPair(
    matchItem(buildIndex(files.slice(0, 2)), "1"),
    pairs,
  );
  assert.equal(single.selected, true);
  assert.deepEqual(
    expandPhotoPairs(selectedFiles([single]), pairs),
    files.slice(0, 2),
  );
  assert.equal(
    resolvePhotoPair(matchItem(buildIndex(files), "1"), pairs).chosen,
    null,
  );
});
test("inferred manufacturer numbers remain unselected even when a pair exists", () => {
  const files = ["a/P1000001.JPG", "a/P1000001.RW2"].map(file);
  const row = resolvePhotoPair(
    matchItem(buildIndex(files), "1"),
    buildPhotoPairs(files),
  );
  assert.equal(row.requiresConfirmation, true);
  assert.equal(row.chosen, null);
  assert.deepEqual(
    expandPhotoPairs(selectedFiles([row]), buildPhotoPairs(files)),
    [],
  );
});
test("explicit extension filter selects base file and pair option adds its companion only", () => {
  const files = ["a/IMG_0001.jpg", "a/IMG_0001.cr3", "b/IMG_0001.nef"].map(
    file,
  );
  const row = matchItem(
    buildIndex(files, ".cr3", { crossFormat: true }),
    "IMG_0001.jpg",
  );
  assert.deepEqual(selectedFiles([row]), [files[1]]);
  assert.deepEqual(
    new Set(expandPhotoPairs(selectedFiles([row]), buildPhotoPairs(files))),
    new Set(files.slice(0, 2)),
  );
  row.selected = false;
  assert.deepEqual(
    expandPhotoPairs(selectedFiles([row]), buildPhotoPairs(files)),
    [],
  );
});

test("case-distinct source folders do not form a pair", () => {
  const files = ["source/A/photo.jpg", "source/a/photo.cr3"].map(file);
  assert.deepEqual(expandPhotoPairs([files[0]], buildPhotoPairs(files)), [
    files[0],
  ]);
});
