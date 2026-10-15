import assert from "node:assert/strict";
import test from "node:test";
import { buildIndex, matchItem, selectedFiles } from "../dist/core.mjs";
const entry = (name, folder = "root") => ({ name, path: `${folder}/${name}` });

test("standard camera prefixes retain automatic exact numeric matching", () => {
  for (const name of [
    "IMG_0001.JPG",
    "_MG_0001.CR3",
    "DSC00001.ARW",
    "_DSC0001.JPG",
    "DSC_0001.NEF",
    "DSCN0001.NRW",
    "DSCF0001.RAF",
    "_DSF0001.JPG",
    "IMGP0001.PEF",
    "_IGP0001.JPG",
    "_IMG0001.JPG",
    "R0000001.DNG",
    "B0000001.3FR",
    "SDIM0001.X3F",
    "FP000001.DNG",
    "GOPR0001.GPR",
  ]) {
    const file = entry(name),
      row = matchItem(buildIndex([file]), "0001");
    assert.equal(row.chosen, file, name);
    assert.equal(row.selected, true, name);
  }
});

const inferred = [
  ["P1000001.RW2", "1", "1000001"],
  ["_1000001.JPG", "1", "1000001"],
  ["P1010001.ORF", "1", "1010001"],
  ["PA150001.JPG", "1", "150001"],
  ["PC310001.ORF", "1", "310001"],
  ["AB120001.CR3", "1", "120001"],
  ["A1298765.ARW", "98765", "1298765"],
  ["_Z630001.NEF", "1", "630001"],
  ["A1230001.PEF", "1", "1230001"],
  ["R0010001.DNG", "1", "10001"],
  ["L1000001.DNG", "1", "1000001"],
  ["DJI_2020012091415_999_WIDE.JPG", "999", null],
  ["DJI_20240101123045_0123_WIDE_Waypoint1.JPG", "123", null],
  ["IMG_1234_1.JPG", "1234", null],
  ["IMG_1234-edit.JPG", "1234", null],
];
for (const [name, number, original] of inferred) {
  test(`camera numeric candidate requires selection: ${name}`, () => {
    const file = entry(name),
      before = JSON.stringify(file),
      index = buildIndex([file]);
    const row = matchItem(index, number);
    assert.deepEqual(row.candidates, [file]);
    assert.equal(row.chosen, null);
    assert.equal(row.selected, false);
    assert.equal(row.requiresConfirmation, true);
    assert.ok(row.candidateReasons.get(file.path));
    assert.deepEqual(selectedFiles([row]), []);
    assert.equal(matchItem(index, name).chosen, file);
    if (original) assert.equal(matchItem(index, original).chosen, file);
    assert.equal(
      JSON.stringify(file),
      before,
      "Never mutate the original entry",
    );
  });
}

test("merge inferred candidates with ordinary matches instead of silently preferring either", () => {
  const plain = entry("DSC_0001.NEF"),
    camera = entry("L1000001.DNG");
  const row = matchItem(buildIndex([plain, camera]), "1");
  assert.deepEqual(row.candidates, [plain, camera]);
  assert.equal(row.chosen, null);
  assert.equal(row.requiresConfirmation, true);
  const sameName = entry("L1000001.DNG", "other-card");
  assert.equal(
    matchItem(buildIndex([camera, sameName]), "1").candidates.length,
    2,
  );
});

test("filters and exact extensions still constrain inferred camera searches", () => {
  const raw = entry("P1000001.RW2"),
    jpeg = entry("P1000001.JPG");
  const row = matchItem(buildIndex([raw, jpeg], ".rw2"), "1");
  assert.deepEqual(row.candidates, [raw]);
  assert.equal(row.chosen, null);
  assert.equal(
    matchItem(buildIndex([raw]), "P1000001.JPG").candidates.length,
    0,
  );
  assert.equal(
    matchItem(buildIndex([raw], ".rw2"), "P1000001.JPG").chosen,
    raw,
  );
});

test("do not truncate long real counters, index suffixes as frames, or infer sidecar/video numbers", () => {
  for (const [name, wrong] of [
    ["DSC123456.JPG", "3456"],
    ["FP123456.DNG", "3456"],
    ["B1234567.3FR", "4567"],
    ["A1298765.ARW", "8765"],
    ["PA150001.JPG", "50001"],
    ["IMG_1234_1.JPG", "1"],
    ["DJI_20240101123045_0123_WIDE_Waypoint1.JPG", "1"],
    ["DJI_20240101123045.JPG", "20240101123045"],
    ["P1000001.MP4", "1"],
    ["P1000001.XMP", "1"],
    ["AB120001.txt", "1"],
    ["unknown123456789.jpg", "6789"],
  ])
    assert.equal(
      matchItem(buildIndex([entry(name)]), wrong).candidates.length,
      0,
      name,
    );
});

test("camera candidate expansion can be disabled while retaining full numeric matching", () => {
  const file = entry("P1000001.RW2"),
    index = buildIndex([file], "", { cameraNumbers: false });
  assert.equal(matchItem(index, "1").candidates.length, 0);
  assert.equal(matchItem(index, "1000001").chosen, file);
});
