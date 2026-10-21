import test from "node:test";
import assert from "node:assert/strict";
import {
  createRawConverter,
  RAW_CONVERT_LIMIT,
  RAW_CONVERT_TIMEOUT,
} from "../dist/raw-convert.mjs";
function fixture() {
  const workers = [];
  let timeout;
  const timers = [];
  const window = {
    Worker: class {
      constructor(url, options) {
        this.url = url;
        this.options = options;
        workers.push(this);
      }
      postMessage(msg) {
        this.msg = msg;
      }
      terminate() {
        this.stopped = true;
      }
    },
    setTimeout(fn, ms) {
      timeout = fn;
      timers.push(ms);
      return 1;
    },
    clearTimeout() {},
  };
  return { window, workers, timers, timeout: () => timeout() };
}
test("RAW converter starts only on demand and terminates on successful JPEG", async () => {
  const f = fixture(),
    converter = createRawConverter(f.window),
    file = new Blob(["raw"]);
  assert.equal(f.workers.length, 0);
  const promise = converter.convert(file);
  const worker = f.workers[0];
  assert.equal(worker.msg.file, file);
  assert.equal(worker.options.type, "module");
  worker.onmessage({
    data: { blob: new Blob(["jpeg"], { type: "image/jpeg" }) },
  });
  assert.equal((await promise).size, 4);
  assert.equal(worker.stopped, true);
  assert.equal(await file.text(), "raw");
});
for (const fault of [
  "timeout",
  "error",
  "messageerror",
  "abort",
  "bad-message",
])
  test(`RAW converter releases worker after ${fault}`, async () => {
    const f = fixture(),
      converter = createRawConverter(f.window),
      controller = new AbortController();
    const promise = converter.convert(new Blob(["raw"]), {
      signal: controller.signal,
    });
    const rejected = assert.rejects(promise);
    const w = f.workers[0];
    if (fault === "timeout") f.timeout();
    else if (fault === "abort") controller.abort();
    else if (fault === "error") w.onerror();
    else if (fault === "messageerror") w.onmessageerror();
    else w.onmessage({ data: { blob: new Blob(["bad"]) } });
    await rejected;
    assert.equal(w.stopped, true);
    const next = converter.convert(new Blob(["next"]));
    const nextRejected = assert.rejects(next);
    converter.cancel();
    await nextRejected;
    assert.equal(f.workers.length, 2);
  });
test("RAW oversized and pre-aborted inputs never create worker or read file", async () => {
  const f = fixture(),
    c = createRawConverter(f.window);
  await assert.rejects(
    c.convert({
      size: RAW_CONVERT_LIMIT + 1,
      arrayBuffer() {
        assert.fail();
      },
    }),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    c.convert(new Blob(["a"]), { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(f.workers.length, 0);
});
test("RAW converter admits one job and rejects concurrent work without disturbing it", async () => {
  const f = fixture(),
    c = createRawConverter(f.window),
    a = c.convert(new Blob(["a"]));
  const rejected = assert.rejects(a);
  await assert.rejects(c.convert(new Blob(["b"])));
  assert.equal(f.workers.length, 1);
  c.cancel();
  await rejected;
});

test("large RAW above former 64MiB cap is sent to one timed disposable worker without main-thread reading", async () => {
  const f = fixture(),
    c = createRawConverter(f.window);
  const file = {
    size: 100 * 1024 * 1024,
    arrayBuffer() {
      assert.fail("main thread read");
    },
  };
  const p = c.convert(file),
    rejected = assert.rejects(p, { name: "AbortError" });
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0].msg.file, file);
  assert.deepEqual(f.timers, [RAW_CONVERT_TIMEOUT]);
  c.cancel();
  await rejected;
  assert.equal(f.workers[0].stopped, true);
});
