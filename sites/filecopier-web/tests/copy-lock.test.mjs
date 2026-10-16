import assert from "node:assert/strict";
import test from "node:test";
import { COPY_LOCK_NAME, withCopyLock } from "../dist/copy-lock.mjs";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
class Locks {
  held = false;
  queue = [];
  request(name, options, task) {
    assert.equal(name, COPY_LOCK_NAME);
    assert.equal(options.mode, "exclusive");
    return new Promise((resolve, reject) => {
      const entry = { name, options, task, resolve, reject, started: false };
      entry.abort = () => {
        if (entry.started) return;
        this.queue = this.queue.filter((item) => item !== entry);
        reject(new DOMException("Cancelled", "AbortError"));
      };
      if (options.signal?.aborted) {
        entry.abort();
        return;
      }
      options.signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }
  pump() {
    if (this.held) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.held = true;
    entry.started = true;
    entry.options.signal?.removeEventListener("abort", entry.abort);
    queueMicrotask(async () => {
      try {
        entry.resolve(
          await entry.task({ name: entry.name, mode: "exclusive" }),
        );
      } catch (error) {
        entry.reject(error);
      } finally {
        this.held = false;
        this.pump();
      }
    });
  }
}
test("copy lock serializes independent tasks through their entire asynchronous cleanup", async () => {
  const locks = new Locks(),
    firstEntered = deferred(),
    finish = deferred(),
    events = [];
  const first = withCopyLock(
    async () => {
      events.push("first-start");
      firstEntered.resolve();
      await finish.promise;
      events.push("first-cleanup");
      return 1;
    },
    { locks },
  );
  await firstEntered.promise;
  const second = withCopyLock(
    async () => {
      events.push("second-start");
      return 2;
    },
    { locks },
  );
  await Promise.resolve();
  assert.deepEqual(events, ["first-start"]);
  finish.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(events, ["first-start", "first-cleanup", "second-start"]);
});
test("cancelling a pending lock never starts its task and leaves the active copy running", async () => {
  const locks = new Locks(),
    held = deferred(),
    finish = deferred(),
    controller = new AbortController();
  const first = withCopyLock(
    async () => {
      held.resolve();
      await finish.promise;
    },
    { locks },
  );
  await held.promise;
  const second = withCopyLock(
    () => assert.fail("Cancelled waiter must not create a folder"),
    { locks, signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(second, { name: "AbortError" });
  assert.equal(locks.held, true);
  finish.resolve();
  await first;
  await withCopyLock(async () => {}, { locks });
});
test("cancelling an active copy does not release its lock before abort cleanup finishes", async () => {
  const locks = new Locks(),
    held = deferred(),
    cleanup = deferred(),
    controller = new AbortController();
  let nextStarted = false;
  const first = withCopyLock(
    async () => {
      held.resolve();
      await cleanup.promise;
      assert.equal(controller.signal.aborted, true);
    },
    { locks, signal: controller.signal },
  );
  await held.promise;
  const second = withCopyLock(
    async () => {
      nextStarted = true;
    },
    { locks },
  );
  controller.abort();
  await Promise.resolve();
  assert.equal(nextStarted, false);
  cleanup.resolve();
  await Promise.all([first, second]);
  assert.equal(nextStarted, true);
});
test("task failure releases the lock only after awaited cleanup and lets the next task proceed", async () => {
  const locks = new Locks(),
    held = deferred(),
    cleanup = deferred();
  let nextStarted = false;
  const first = withCopyLock(
    async () => {
      held.resolve();
      try {
        throw new Error("write failed");
      } finally {
        await cleanup.promise;
      }
    },
    { locks },
  );
  await held.promise;
  const failure = assert.rejects(first, /write failed/);
  const second = withCopyLock(
    async () => {
      nextStarted = true;
    },
    { locks },
  );
  await Promise.resolve();
  assert.equal(nextStarted, false);
  cleanup.resolve();
  await Promise.all([failure, second]);
  assert.equal(nextStarted, true);
});
test("unsupported or denied lock access never starts filesystem work", async () => {
  for (const locks of [
    null,
    {},
    {
      request: async () => {
        throw new DOMException("Denied", "SecurityError");
      },
    },
  ])
    await assert.rejects(
      withCopyLock(() => assert.fail("No unlocked writes"), { locks }),
      /잠금/,
    );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    withCopyLock(() => assert.fail("No cancelled writes"), {
      locks: new Locks(),
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
});
test("lock acquired and waiting callbacks report order without exposing file data", async () => {
  const events = [];
  await withCopyLock(async () => events.push("copy"), {
    locks: new Locks(),
    onWaiting: () => events.push("waiting"),
    onAcquired: () => events.push("acquired"),
  });
  assert.deepEqual(events, ["waiting", "acquired", "copy"]);
});
