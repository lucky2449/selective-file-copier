import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { extractRawPreview, RAW_SCAN_LIMIT } from "../dist/raw-preview.mjs";
import { jpegOrientation } from "../dist/preview-orientation.mjs";

// Structural fixtures, not a claim of real camera/decoder compatibility.
const jpeg = new Uint8Array([
  255, 216, 255, 192, 0, 11, 8, 0, 16, 0, 16, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1,
  0, 0, 63, 0, 12, 255, 0, 34, 255, 208, 56, 255, 217,
]);
const target = RAW_SCAN_LIMIT + 4096;
function tiff({
  magic = 42,
  little = true,
  sub = false,
  panasonic = false,
  cycle = false,
} = {}) {
  const bytes = new Uint8Array(512),
    view = new DataView(bytes.buffer);
  bytes.set(little ? [73, 73] : [77, 77]);
  const u16 = (p, v) => view.setUint16(p, v, little),
    u32 = (p, v) => view.setUint32(p, v, little);
  u16(2, magic);
  u32(4, 8);
  const tag = (p, id, type, count, value) => {
    u16(p, id);
    u16(p + 2, type);
    u32(p + 4, count);
    if (type === 3 && count === 1) u16(p + 8, value);
    else u32(p + 8, value);
  };
  u16(8, sub ? 2 : panasonic ? 2 : 3);
  tag(10, 0x112, 3, 1, 6);
  let at = 22;
  if (sub) {
    tag(at, 0x14a, 4, 1, 96);
    u16(96, 2);
    at = 98;
  }
  if (panasonic) tag(at, 0x2e, 7, jpeg.length, target);
  else {
    tag(at, 0x201, 4, 1, target);
    tag(at + 12, 0x202, 4, 1, jpeg.length);
  }
  if (cycle) u32(8 + 2 + u16Count(sub, panasonic) * 12, 8);
  return bytes;
}
const u16Count = (sub, panasonic) => (sub || panasonic ? 2 : 3);
function raf() {
  const b = new Uint8Array(512),
    v = new DataView(b.buffer);
  b.set(new TextEncoder().encode("FUJIFILMCCD-RAW "));
  v.setUint32(84, target);
  v.setUint32(88, jpeg.length);
  return b;
}
function sparse(header, preview = jpeg, size = target + jpeg.length) {
  const reads = [];
  return {
    size,
    reads,
    slice(start, end) {
      reads.push([start, end]);
      assert.ok(end - start <= RAW_SCAN_LIMIT);
      if (start === 0) return new Blob([header]);
      assert.equal(start, target);
      assert.ok(end <= size);
      return new Blob([preview]);
    },
    arrayBuffer() {
      assert.fail("Whole RAW must not be read for extraction");
    },
  };
}
for (const [format, options] of [
  ["Nikon NEF", {}],
  ["Sony ARW", { sub: true }],
  ["DNG", { sub: true, little: false }],
  ["Panasonic RW2", { magic: 85, panasonic: true }],
  ["Olympus ORF", { magic: 0x4f52 }],
  ["Olympus ORF alternate", { magic: 0x5352 }],
  ["Canon CR2", {}],
])
  test(`${format}: follow bounded preview offset beyond scan without changing metadata`, async () => {
    const header = tiff(options),
      before = header.slice(),
      f = sparse(header);
    const blob = await extractRawPreview(f);
    assert.equal(blob.type, "image/jpeg");
    assert.equal(jpegOrientation(new Uint8Array(await blob.arrayBuffer())), 6);
    assert.deepEqual(header, before);
    assert.deepEqual(f.reads, [
      [0, RAW_SCAN_LIMIT],
      [target, target + jpeg.length],
    ]);
  });
test("Fuji RAF: header preview offset beyond scan", async () => {
  const header = raf(),
    before = header.slice(),
    f = sparse(header);
  assert.deepEqual(
    new Uint8Array(await (await extractRawPreview(f)).arrayBuffer()),
    jpeg,
  );
  assert.deepEqual(header, before);
  assert.equal(f.reads.length, 2);
});
for (const [label, mutate] of [
  ["offset outside source", (v) => v.setUint32(30, 0xfffffff0, true)],
  ["oversized preview", (v) => v.setUint32(42, 13 * 1024 * 1024, true)],
  ["zero length", (v) => v.setUint32(42, 0, true)],
  ["bad first IFD", (v) => v.setUint32(4, 0xfffffff0, true)],
  ["too many entries", (v) => v.setUint16(8, 4097, true)],
])
  test(`invalid metadata: ${label} does not issue an external range read`, async () => {
    const h = tiff();
    mutate(new DataView(h.buffer));
    const f = sparse(h);
    assert.equal(await extractRawPreview(f), null);
    assert.equal(f.reads.length, 1);
  });
test("IFD cycle terminates; damaged remote preview falls back to bounded scan", async () => {
  const h = tiff({ cycle: true });
  h.set(jpeg, 256);
  const f = sparse(h, new Uint8Array([255, 216, 255, 217]));
  assert.ok(await extractRawPreview(f));
  assert.equal(f.reads.length, 2);
});
test("declared remote JPEG with truncated data is rejected", async () => {
  assert.equal(
    await extractRawPreview(sparse(tiff(), jpeg.slice(0, -2))),
    null,
  );
});
test("RW2 undeclared TIFF tag is not followed in ordinary TIFF", async () => {
  const f = sparse(tiff({ panasonic: true }));
  assert.equal(await extractRawPreview(f), null);
  assert.equal(f.reads.length, 1);
});
test("real Blob source bytes remain identical after offset-based extraction", async () => {
  const h = tiff();
  const v = new DataView(h.buffer);
  v.setUint32(30, 512, true);
  const file = new Blob([h, jpeg]);
  const hash = async () =>
    createHash("sha256")
      .update(new Uint8Array(await file.arrayBuffer()))
      .digest("hex");
  const before = await hash();
  assert.ok(await extractRawPreview(file));
  assert.equal(await hash(), before);
});

test("unreadable declared range falls back to a valid scanned JPEG", async () => {
  const h = tiff();
  h.set(jpeg, 256);
  const f = sparse(h);
  const slice = f.slice.bind(f);
  f.slice = (start, end) =>
    start
      ? {
          arrayBuffer: async () => {
            throw new Error("unreadable");
          },
        }
      : slice(start, end);
  assert.ok(await extractRawPreview(f));
});

test("many declared previews are limited to eight reads", async () => {
  const h = new Uint8Array(512),
    v = new DataView(h.buffer);
  h.set([73, 73, 42, 0, 8]);
  for (let i = 0; i < 12; i++) {
    const at = 8 + i * 30;
    v.setUint16(at, 2, true);
    for (const [index, tag, value] of [
      [0, 0x201, target + i * 100],
      [1, 0x202, jpeg.length],
    ]) {
      const p = at + 2 + index * 12;
      v.setUint16(p, tag, true);
      v.setUint16(p + 2, 4, true);
      v.setUint32(p + 4, 1, true);
      v.setUint32(p + 8, value, true);
    }
    v.setUint32(at + 26, i === 11 ? 0 : at + 30, true);
  }
  let ranges = 0;
  const file = {
    size: target + 4096,
    slice(start) {
      if (!start) return new Blob([h]);
      ranges++;
      return new Blob([new Uint8Array(jpeg.length)]);
    },
  };
  assert.equal(await extractRawPreview(file), null);
  assert.equal(ranges, 8);
});
