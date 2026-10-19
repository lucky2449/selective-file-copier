import test from "node:test";
import assert from "node:assert/strict";
import {
  createPreviewResolver,
  createPreviewManager,
  makeThumbnail,
} from "../dist/thumbnail.mjs";
const entry = (path) => ({
  path,
  name: path.split("/").at(-1),
  file: new Blob(["original"]),
});
test("preview resolves same-folder RAW companion independently of output filters", () => {
  const jpg = entry("A/IMG_0001.JPG"),
    raw = entry("A/img_0001.CR3");
  const resolve = createPreviewResolver([jpg, raw, entry("B/img_0001.jpg")]);
  assert.equal(resolve(raw), jpg);
  assert.equal(resolve(jpg), jpg);
  assert.equal(resolve(entry("a/img_0001.CR3")).name, "img_0001.CR3");
  assert.equal(resolve(entry("A/IMG_0001.MP4")), null);
  assert.equal(resolve(null), null);
  assert.deepEqual(raw.file.size, 8);
});
test("ambiguous JPG companions never select an arbitrary preview", () => {
  const resolve = createPreviewResolver([entry("A/1.jpg"), entry("A/1.jpeg")]);
  assert.equal(resolve(entry("A/1.cr3")).name, "1.cr3");
});
class Element {
  children = [];
  handlers = {};
  style = {};
  hidden = false;
  textContent = "";
  offsetHeight = 260;
  append(...nodes) {
    this.children.push(...nodes);
  }
  setAttribute() {}
  removeAttribute() {}
  remove() {
    this.removed = true;
  }
  addEventListener(event, fn) {
    this.handlers[event] = fn;
  }
  getBoundingClientRect() {
    return { top: 100, left: 500, right: 532 };
  }
}
const flush = () => new Promise((r) => setImmediate(r));
function fixture(decode) {
  let observe;
  const revoked = [],
    made = [],
    body = new Element(),
    docHandlers = {};
  const document = {
    body,
    createElement: () => new Element(),
    addEventListener: (k, v) => (docHandlers[k] = v),
  };
  const window = {
    innerWidth: 900,
    innerHeight: 700,
    addEventListener() {},
    URL: {
      createObjectURL: (b) => {
        made.push(b);
        return "blob:" + made.length;
      },
      revokeObjectURL: (u) => revoked.push(u),
    },
    IntersectionObserver: class {
      constructor(fn) {
        observe = fn;
      }
      observe() {}
      disconnect() {}
    },
  };
  const manager = createPreviewManager({
    window,
    document,
    root: new Element(),
    decode,
  });
  const attach = () => {
    const cell = new Element();
    manager.attach(cell, entry("A/1.jpg"));
    return cell.children[0];
  };
  return {
    manager,
    attach,
    visible: (target, value = true) =>
      observe([{ target, isIntersecting: value }]),
    revoked,
    made,
    body,
    docHandlers,
  };
}
test("offscreen previews are lazy, leaving viewport revokes memory, reset releases all", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return new Blob(["thumb"]);
  });
  const button = f.attach();
  await flush();
  assert.equal(calls, 0);
  f.visible(button);
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.made.length, 1);
  f.visible(button, false);
  assert.deepEqual(f.revoked, ["blob:1"]);
  f.visible(button);
  await flush();
  f.manager.reset();
  assert.deepEqual(f.revoked, ["blob:1", "blob:2"]);
});
test("only two decodes run simultaneously and reset discards stale work", async () => {
  const resolves = [];
  const f = fixture(() => new Promise((r) => resolves.push(r)));
  const buttons = Array.from({ length: 8 }, () => f.attach());
  buttons.forEach((b) => f.visible(b));
  await flush();
  assert.equal(resolves.length, 2);
  f.manager.reset();
  resolves.forEach((r) => r(new Blob(["thumb"])));
  await flush();
  assert.equal(f.made.length, 0);
  assert.equal(resolves.length, 2);
});
test("decode failure is isolated and does not repeatedly retry corrupt photos", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    throw Error("invalid image");
  });
  const b = f.attach();
  f.visible(b);
  await flush();
  assert.equal(b.textContent, "—");
  f.visible(b);
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.made.length, 0);
});
test("Escape during decode prevents late popup and previews never select files", async () => {
  let done;
  const f = fixture(() => new Promise((r) => (done = r)));
  const b = f.attach();
  b.handlers.mouseenter();
  await flush();
  f.docHandlers.keydown({ key: "Escape" });
  done(new Blob(["thumb"]));
  await flush();
  assert.equal(f.body.children.length, 0);
  b.handlers.focus();
  assert.equal(f.body.children.length, 1);
  assert.equal(f.body.children[0].hidden, false);
  b.handlers.blur();
  assert.equal(f.body.children[0].hidden, true);
});
test("thumbnail is bounded, encoded at low quality and bitmap is always closed", async () => {
  let closed = 0;
  const file = new Blob(["source"]);
  let canvas;
  const blob = await makeThumbnail(file, {
    window: {
      createImageBitmap: async (input, opts) => {
        assert.equal(input, file);
        assert.equal(opts.resizeWidth, 320);
        return { width: 320, height: 640, close: () => closed++ };
      },
    },
    document: {
      createElement: () =>
        (canvas = {
          getContext: () => ({ drawImage() {} }),
          toBlob(cb, type, quality) {
            assert.equal(type, "image/jpeg");
            assert.equal(quality, 0.55);
            cb(new Blob(["thumb"]));
          },
        }),
    },
  });
  assert.equal(canvas.width, 160);
  assert.equal(canvas.height, 320);
  assert.equal(closed, 1);
  assert.equal(blob.size, 5);
  assert.equal(await file.text(), "source");
});
test("bitmap is closed even when canvas encoding fails", async () => {
  let closed = false;
  await assert.rejects(
    makeThumbnail(new Blob(), {
      window: {
        createImageBitmap: async () => ({
          width: 20,
          height: 20,
          close: () => (closed = true),
        }),
      },
      document: { createElement: () => ({ getContext: () => null }) },
    }),
  );
  assert.equal(closed, true);
});
import { extractRawPreview, RAW_SCAN_LIMIT } from "../dist/raw-preview.mjs";
const embeddedJpeg = (marker = 0xc0) =>
  new Uint8Array([
    255,
    216,
    255,
    marker,
    0,
    11,
    8,
    0,
    16,
    0,
    16,
    1,
    1,
    17,
    0,
    255,
    218,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    12,
    255,
    0,
    34,
    255,
    208,
    56,
    255,
    217,
  ]);
test("RAW extraction returns only embedded JPEG and preserves source bytes", async () => {
  const jpg = embeddedJpeg();
  const source = new Blob([new Uint8Array(75), jpg, new Uint8Array(20)]);
  const before = new Uint8Array(await source.arrayBuffer());
  const result = await extractRawPreview(source);
  assert.equal(result.type, "image/jpeg");
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), jpg);
  assert.deepEqual(new Uint8Array(await source.arrayBuffer()), before);
});
test("RAW extraction rejects missing, truncated, lossless and oversized JPEG previews", async () => {
  assert.equal(await extractRawPreview(new Blob(["no preview"])), null);
  assert.equal(
    await extractRawPreview(new Blob([embeddedJpeg().slice(0, -2)])),
    null,
  );
  assert.equal(await extractRawPreview(new Blob([embeddedJpeg(0xc3)])), null);
  const huge = embeddedJpeg();
  huge.set([255, 255, 255, 255], 7);
  assert.equal(await extractRawPreview(new Blob([huge])), null);
});
test("RAW scan reads only bounded slice, never the complete source", async () => {
  let called = 0;
  const source = {
    slice(start, end) {
      called++;
      assert.equal(start, 0);
      assert.equal(end, RAW_SCAN_LIMIT);
      return new Blob([embeddedJpeg(0xc2)]);
    },
    arrayBuffer() {
      throw Error("whole file read");
    },
  };
  assert.ok(await extractRawPreview(source));
  assert.equal(called, 1);
});
test("malformed JPEG candidate does not hide a later valid preview", async () => {
  const result = await extractRawPreview(
    new Blob([new Uint8Array([255, 216, 255, 224, 255, 255]), embeddedJpeg()]),
  );
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), embeddedJpeg());
});
test("RAW without embedded JPEG never reaches the browser decoder", async () => {
  await assert.rejects(
    makeThumbnail(new Blob(["raw"]), {
      raw: true,
      window: {
        createImageBitmap() {
          assert.fail("should not decode RAW");
        },
      },
      document: {},
    }),
    /Preview unavailable/,
  );
});
