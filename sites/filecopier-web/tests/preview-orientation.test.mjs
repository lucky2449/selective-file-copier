import test from "node:test";
import assert from "node:assert/strict";
import {
  tiffOrientation,
  rawOrientation,
  jpegOrientation,
  orientedPreview,
} from "../dist/preview-orientation.mjs";
function tiff(orientation, little = true) {
  const b = new Uint8Array(26),
    v = new DataView(b.buffer);
  b.set(little ? [73, 73] : [77, 77]);
  v.setUint16(2, 42, little);
  v.setUint32(4, 8, little);
  v.setUint16(8, 1, little);
  v.setUint16(10, 0x112, little);
  v.setUint16(12, 3, little);
  v.setUint32(14, 1, little);
  v.setUint16(18, orientation, little);
  return b;
}
const jpeg = new Uint8Array([255, 216, 255, 217]);
for (let orientation = 1; orientation <= 8; orientation++)
  test(`orientation ${orientation} is propagated without changing RAW/JPEG bytes`, async () => {
    const raw = tiff(orientation),
      before = raw.slice(),
      jpgBefore = jpeg.slice();
    assert.equal(rawOrientation(raw), orientation);
    const out = new Uint8Array(await orientedPreview(raw, jpeg).arrayBuffer());
    assert.equal(jpegOrientation(out), orientation === 1 ? null : orientation);
    assert.deepEqual(raw, before);
    assert.deepEqual(jpeg, jpgBefore);
  });
test("big endian TIFF and Canon CR3 CMT1 orientation are read within bounds", () => {
  assert.equal(tiffOrientation(tiff(6, false)), 6);
  const b = new Uint8Array(16 + 8 + 26),
    v = new DataView(b.buffer);
  b.set([102, 116, 121, 112], 4);
  v.setUint32(16, 34);
  b.set([67, 77, 84, 49], 20);
  b.set(tiff(8), 24);
  assert.equal(rawOrientation(b), 8);
  v.setUint32(16, 0xffffffff);
  assert.equal(rawOrientation(b), null);
});
test("embedded JPEG orientation wins, including explicit normal orientation", async () => {
  const embedded = new Uint8Array(
    await orientedPreview(tiff(6), jpeg).arrayBuffer(),
  );
  const result = new Uint8Array(
    await orientedPreview(tiff(8), embedded).arrayBuffer(),
  );
  assert.deepEqual(result, embedded);
  assert.equal(jpegOrientation(result), 6);
  const normal = embedded.slice();
  normal[30] = 1;
  assert.equal(jpegOrientation(normal), 1);
  assert.deepEqual(
    new Uint8Array(await orientedPreview(tiff(8), normal).arrayBuffer()),
    normal,
  );
});
test("invalid, truncated, unknown or malicious TIFF offsets remain unoriented", async () => {
  for (const b of [new Uint8Array(), tiff(0), tiff(9), tiff(8).slice(0, 18)])
    assert.equal(rawOrientation(b), null);
  const bad = tiff(8);
  new DataView(bad.buffer).setUint32(4, 0xfffffffe, true);
  assert.equal(rawOrientation(bad), null);
  assert.deepEqual(
    new Uint8Array(await orientedPreview(bad, jpeg).arrayBuffer()),
    jpeg,
  );
});
test("an unrelated EXIF block inside arbitrary RAW bytes is never treated as primary orientation", () => {
  const b = new Uint8Array(40);
  b.set(tiff(6), 10);
  assert.equal(rawOrientation(b), null);
});
