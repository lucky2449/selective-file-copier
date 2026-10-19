import test from "node:test";
import assert from "node:assert/strict";
import { prepareZipDownload, pruneZipTemps } from "../dist/zip-download.mjs";
import { zipSize } from "../dist/zip-storage.mjs";
function fixture(fault = "") {
  const state = { parts: [], closed: 0, aborted: 0, removed: [], created: 0 };
  const directory = {
    async *values() {},
    async removeEntry(name) {
      state.removed.push(name);
    },
    async getFileHandle(name, opts) {
      if (!opts?.create) throw new DOMException("Missing", "NotFoundError");
      state.created++;
      return {
        async getFile() {
          return new Blob(state.parts);
        },
        async createWritable() {
          if (fault === "open") throw new Error("permission denied");
          return {
            async write(chunk) {
              if (fault === "write" || fault === "abort")
                throw new DOMException("Full", "QuotaExceededError");
              state.parts.push(chunk);
            },
            async close() {
              if (fault === "close") throw new Error("commit failed");
              state.closed++;
            },
            async abort() {
              state.aborted++;
              if (fault === "abort") throw new Error("abort failed");
            },
          };
        },
      };
    },
  };
  const storage = {
    estimate: async () => ({ quota: 1e10, usage: 0 }),
    getDirectory: async () => ({
      getDirectoryHandle: async (name) => {
        assert.equal(name, "filemoa-zip-downloads-v1");
        return directory;
      },
    }),
  };
  return { state, storage, directory };
}
const files = () => [{ name: "사진.CR3", file: new Blob(["original"]) }];
test("OPFS ZIP streams and returns file without folder permissions", async () => {
  const { state, storage } = fixture();
  const f = files();
  const file = await prepareZipDownload(f, { storage });
  assert.equal(file.size, zipSize(f));
  assert.equal(state.closed, 1);
  assert.equal(state.removed.length, 0);
  assert.equal(await f[0].file.text(), "original");
  assert.ok((await file.text()).includes("original"));
});
for (const fault of ["open", "write", "close", "abort"]) {
  test(`OPFS ${fault} rejects and cleans only owned temp file`, async () => {
    const { state, storage } = fixture(fault);
    await assert.rejects(prepareZipDownload(files(), { storage }));
    assert.equal(state.closed, 0);
    assert.equal(state.removed.length, 1);
    assert.match(state.removed[0], /^zip-/);
    if (fault !== "open") assert.equal(state.aborted, 1);
  });
}
test("quota preflight and over-limit reject before creating temporary files", async () => {
  const { state, storage } = fixture();
  storage.estimate = async () => ({ quota: 1, usage: 0 });
  await assert.rejects(prepareZipDownload(files(), { storage }), {
    name: "QuotaExceededError",
  });
  assert.equal(state.created, 0);
  await assert.rejects(
    prepareZipDownload([{ name: "x", file: { size: 4 * 1024 ** 3 } }], {
      storage,
    }),
    /4GB/,
  );
  assert.equal(state.created, 0);
});
test("cancel during OPFS writing aborts and never returns a completed file", async () => {
  const { state, storage } = fixture();
  await assert.rejects(
    prepareZipDownload(files(), {
      storage,
      cancelled: () => state.parts.length > 0,
    }),
    { name: "AbortError" },
  );
  assert.equal(state.closed, 0);
  assert.equal(state.aborted, 1);
  assert.equal(state.removed.length, 1);
});
test("size mismatch aborts before close", async () => {
  const { state, storage } = fixture();
  const file = new Blob(["original"]);
  Object.defineProperty(file, "size", { value: 99 });
  await assert.rejects(
    prepareZipDownload([{ name: "x", file }], { storage }),
    /크기/,
  );
  assert.equal(state.closed, 0);
  assert.equal(state.aborted, 1);
});
test("unsupported OPFS uses small ZIP fallback and rejects above 512MiB", async () => {
  assert.ok(
    (await (await prepareZipDownload(files())).text()).includes("original"),
  );
  await assert.rejects(
    prepareZipDownload([{ name: "x", file: { size: 512 * 1024 ** 2 } }]),
    /512MB/,
  );
});
test("pruning only removes old application-owned private temp files", async () => {
  const removed = [],
    now = 1800000000000;
  const old = `zip-${now - 8 * 86400000}-00000000-0000-0000-0000-000000000000.tmp`,
    recent = `zip-${now}-00000000-0000-0000-0000-000000000000.tmp`;
  await pruneZipTemps(
    {
      async *values() {
        for (const name of [old, recent, "photo.JPG", "zip-invalid.tmp"])
          yield { name, kind: "file" };
        yield { name: old, kind: "directory" };
      },
      async removeEntry(name) {
        removed.push(name);
      },
    },
    now,
  );
  assert.deepEqual(removed, [old]);
});

for (const scenario of ["reclaimed", "still-full", "remove-denied"]) {
  test(`quota estimate runs after expired temporary cleanup: ${scenario}`, async () => {
    const { state, storage, directory } = fixture();
    const calls = [];
    const old = `zip-${Date.now() - 8 * 86400000}-00000000-0000-0000-0000-000000000000.tmp`;
    let reclaimed = false;
    directory.values = async function* () {
      yield { name: old, kind: "file" };
      yield { name: "photo.JPG", kind: "file" };
    };
    directory.removeEntry = async (name) => {
      calls.push("remove");
      assert.equal(name, old);
      if (scenario === "remove-denied")
        throw new DOMException("Denied", "NotAllowedError");
      reclaimed = true;
    };
    storage.estimate = async () => {
      calls.push("estimate");
      assert.deepEqual(calls, ["remove", "estimate"]);
      return {
        quota: 10000,
        usage: scenario === "reclaimed" && reclaimed ? 0 : 10000,
      };
    };
    if (scenario === "reclaimed") {
      const file = await prepareZipDownload(files(), { storage });
      assert.equal(file.size, zipSize(files()));
      assert.equal(state.closed, 1);
    } else {
      await assert.rejects(prepareZipDownload(files(), { storage }), {
        name: "QuotaExceededError",
      });
      assert.equal(state.created, 0);
    }
    assert.deepEqual(calls, ["remove", "estimate"]);
  });
}
test("cancellation after expired cleanup skips quota estimate and new temporary file", async () => {
  const { state, storage, directory } = fixture();
  let cancelled = false;
  directory.values = async function* () {
    cancelled = true;
  };
  storage.estimate = async () =>
    assert.fail("Cancelled operation must not continue");
  await assert.rejects(
    prepareZipDownload(files(), { storage, cancelled: () => cancelled }),
    { name: "AbortError" },
  );
  assert.equal(state.created, 0);
});
