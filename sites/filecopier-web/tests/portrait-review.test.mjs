import test from "node:test";
import { webcrypto } from "node:crypto";
import assert from "node:assert/strict";
import { createPortraitReviewer } from "../dist/portrait-review.mjs";
function setup(crypto) {
  const workers = [],
    timers = new Map();
  let next = 0;
  class Worker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      workers.push(this);
    }
    postMessage(data) {
      this.sent = data;
    }
    terminate() {
      this.terminated = true;
    }
  }
  const window = {
    Worker,
    crypto,
    setTimeout(fn) {
      const id = ++next;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  return { reviewer: createPortraitReviewer(window), workers, timers };
}
const file = { size: 123 };
test("portrait wrapper only sends read-only input to a reusable same-origin worker", async () => {
  const { reviewer, workers, timers } = setup();
  const pending = reviewer.analyze(file);
  const worker = workers[0];
  assert.match(worker.url.pathname, /portrait-review-worker.mjs$/);
  assert.equal(worker.options.type, "module");
  assert.deepEqual(Object.keys(worker.sent).sort(), [
    "file",
    "motionProfile",
    "profile",
  ]);
  const result = { algorithmVersion: "native-face-eyes-v1", route: "portrait" };
  worker.onmessage({ data: { result } });
  assert.deepEqual(await pending, result);
  assert.equal(worker.terminated, undefined);
  assert.equal(timers.size, 0);
});
test("cancel and timeout terminate work without changing original file", async () => {
  const a = setup(),
    controller = new AbortController(),
    pending = a.reviewer.analyze(file, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(a.workers[0].terminated, true);
  assert.deepEqual(file, { size: 123 });
  const b = setup(),
    timed = b.reviewer.analyze(file);
  [...b.timers.values()][0]();
  await assert.rejects(timed, /timeout/);
  assert.equal(b.workers[0].terminated, true);
});
test("invalid sizes, concurrency and worker errors never report successful review", async () => {
  const { reviewer, workers } = setup();
  for (const size of [0, Infinity, 100_000_000])
    await assert.rejects(reviewer.analyze({ size }));
  const pending = reviewer.analyze(file);
  await assert.rejects(reviewer.analyze(file), /unavailable/);
  workers[0].onerror();
  await assert.rejects(pending, /unavailable/);
});

test("successful photos reuse worker; dispose releases idle model and permits restart", async () => {
  const { reviewer, workers } = setup();
  const result = { algorithmVersion: "native-face-eyes-v1", route: "portrait" };
  for (let i = 0; i < 3; i++) {
    const pending = reviewer.analyze(file);
    workers[0].onmessage({ data: { result } });
    await pending;
  }
  assert.equal(workers.length, 1);
  reviewer.dispose();
  assert.equal(workers[0].terminated, true);
  const pending = reviewer.analyze(file);
  assert.equal(workers.length, 2);
  reviewer.dispose();
  await assert.rejects(pending, { name: "AbortError" });
});
test("aborted and failed workers are replaced; late responses cannot finish new jobs", async () => {
  const { reviewer, workers } = setup();
  const first = reviewer.analyze(file);
  const stale = workers[0].onmessage;
  reviewer.cancel();
  await assert.rejects(first, { name: "AbortError" });
  const second = reviewer.analyze(file);
  const result = { algorithmVersion: "native-face-eyes-v1", route: "portrait" };
  stale({ data: { result } });
  workers[1].onmessage({ data: { error: "Photo review failed (model)" } });
  await assert.rejects(second, /failed/);
  assert.equal(workers[1].terminated, true);
  const third = reviewer.analyze(file);
  workers[2].onmessage({ data: { result } });
  assert.deepEqual(await third, result);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const blob = (text) => new Blob([text], { type: "image/jpeg" });
const good = {
  algorithmVersion: "native-face-eyes-v1",
  route: "portrait",
  faces: [{ score: 1 }],
};
async function complete(pending, workers) {
  for (let i = 0; i < 100 && !workers.at(-1)?.sent; i++) await tick();
  workers.at(-1).onmessage({ data: { result: structuredClone(good) } });
  return pending;
}
test("content cache survives reselection, isolates returned results and invalidates changed bytes/profile", async () => {
  const { reviewer, workers } = setup(webcrypto);
  const first = await complete(reviewer.analyze(blob("abc")), workers);
  first.faces[0].score = 999;
  const sent = workers[0].sent;
  const cached = await reviewer.analyze(blob("abc"));
  assert.equal(workers[0].sent, sent);
  assert.equal(cached.faces[0].score, 1);
  cached.faces.length = 0;
  assert.equal((await reviewer.analyze(blob("abc"))).faces.length, 1);
  workers[0].sent = null;
  await complete(reviewer.analyze(blob("abd")), workers);
  workers[0].sent = null;
  await complete(
    reviewer.analyze(blob("abc"), { profile: { version: "different" } }),
    workers,
  );
  reviewer.clearCache();
  workers[0].sent = null;
  await complete(reviewer.analyze(blob("abc")), workers);
  reviewer.dispose();
});
test("cancel during fingerprinting never launches a worker or populates cache", async () => {
  const { reviewer, workers } = setup(webcrypto);
  let release;
  const input = {
    size: 3,
    arrayBuffer: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const pending = reviewer.analyze(input);
  reviewer.cancel();
  await assert.rejects(pending, { name: "AbortError" });
  release(new Uint8Array([1, 2, 3]).buffer);
  await tick();
  assert.equal(workers.length, 0);
});
test("cache is bounded and evicts least recently used results", async () => {
  const { reviewer, workers } = setup(webcrypto);
  for (let i = 0; i < 129; i++) {
    if (workers[0]) workers[0].sent = null;
    await complete(reviewer.analyze(blob(String(i))), workers);
  }
  workers[0].sent = null;
  await complete(reviewer.analyze(blob("0")), workers);
  assert.ok(workers[0].sent);
  reviewer.dispose();
});

test("changing a motion profile cannot reuse a stale photo decision", async () => {
  const { reviewer, workers } = setup(webcrypto);
  await complete(
    reviewer.analyze(blob("motion-input"), {
      motionProfile: { version: "first" },
    }),
    workers,
  );
  const previous = workers[0].sent;
  workers[0].sent = null;
  await complete(
    reviewer.analyze(blob("motion-input"), {
      motionProfile: { version: "second" },
    }),
    workers,
  );
  assert.notEqual(workers[0].sent, previous);
  assert.equal(workers[0].sent.motionProfile.version, "second");
  reviewer.dispose();
});
