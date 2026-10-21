import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RAW_CONVERT_LIMIT, RAW_PIXEL_LIMIT } from "../dist/raw-convert.mjs";

// Run the production worker with a tiny deterministic decoder/canvas double.
// This verifies resource gates, not real high-resolution camera decoding.
const source = (
  await readFile(
    new URL("../dist/raw-convert-worker.mjs", import.meta.url),
    "utf8",
  )
).replace(/^import .*;\r?\n/gm, "");
async function run({ pixels = 61_000_000, overFileLimit = false } = {}) {
  let images = 0,
    deleted = 0,
    opened = 0;
  const output = [];
  class Raw {
    open() {
      opened++;
    }
    metadata() {
      return { raw_width: pixels, raw_height: 1, width: 2, height: 2 };
    }
    imageData() {
      images++;
      return {
        width: 2,
        height: 2,
        colors: 3,
        bits: 8,
        data: new Uint8Array(12),
      };
    }
    delete() {
      deleted++;
    }
  }
  const self = { postMessage: (data) => output.push(data) };
  class Canvas {
    getContext() {
      return {
        createImageData: (w, h) => ({ data: new Uint8Array(w * h * 4) }),
        putImageData() {},
      };
    }
    async convertToBlob() {
      return new Blob(["jpeg"], { type: "image/jpeg" });
    }
  }
  const install = new Function(
    "LibRawModule",
    "RAW_CONVERT_LIMIT",
    "RAW_PIXEL_LIMIT",
    "self",
    "OffscreenCanvas",
    "Blob",
    source,
  );
  install(
    async () => ({ LibRaw: Raw }),
    RAW_CONVERT_LIMIT,
    RAW_PIXEL_LIMIT,
    self,
    Canvas,
    Blob,
  );
  const file = new Blob(["raw"]);
  if (overFileLimit)
    Object.defineProperty(file, "size", { value: RAW_CONVERT_LIMIT + 1 });
  await self.onmessage({ data: { file } });
  return { images, deleted, opened, output };
}
test("worker admits 61MP and 102MP metadata beyond former 50MP cap", async () => {
  for (const pixels of [61_000_000, 102_000_000, RAW_PIXEL_LIMIT]) {
    const r = await run({ pixels });
    assert.equal(r.images, 1);
    assert.equal(r.deleted, 1);
    assert.equal(r.output[0].blob.type, "image/jpeg");
  }
});
test("worker rejects sensor over cap before imageData and releases decoder", async () => {
  const r = await run({ pixels: RAW_PIXEL_LIMIT + 1 });
  assert.equal(r.images, 0);
  assert.equal(r.deleted, 1);
  assert.equal(r.output[0].error, "RAW_PREVIEW_UNAVAILABLE");
});
test("worker rejects invalid metadata and oversized files", async () => {
  for (const pixels of [NaN, Infinity, -1, 1.5]) {
    const r = await run({ pixels });
    assert.equal(r.images, 0);
    assert.equal(r.deleted, 1);
  }
  const r = await run({ overFileLimit: true });
  assert.equal(r.opened, 0);
  assert.equal(r.images, 0);
});
