import test from "node:test";
import assert from "node:assert/strict";
import {
  saveZipToDirectory,
  zipSize,
  DISK_ZIP_LIMIT,
  DOWNLOAD_ZIP_LIMIT,
} from "../dist/zip-storage.mjs";
import { COPY_LOCK_NAME } from "../dist/copy-lock.mjs";
const entries = () => [
  { name: "사진.JPG", file: new Blob(["jpeg original"]) },
  { name: "사진.CR3", file: new Blob(["raw original"]) },
];
function fixture(fault = "") {
  const state = {
    held: false,
    folders: 0,
    writes: 0,
    bytes: 0,
    closed: 0,
    aborted: 0,
    chunks: [],
    cancelled: false,
  };
  const target = {
    getFile: async () => ({
      size: fault === "existing" ? 4 : 0,
      lastModified: 1,
    }),
    async createWritable(options) {
      assert.equal(options.mode, "exclusive");
      if (fault === "open") throw new Error("permission denied");
      return {
        async write(chunk) {
          assert.ok(state.held);
          state.writes++;
          state.bytes += chunk.byteLength;
          if (fault === "write") throw new Error("disk full");
          if (fault === "cancel") state.cancelled = true;
          if (fault !== "large") state.chunks.push(chunk);
        },
        async close() {
          assert.ok(state.held);
          if (fault === "close") throw new Error("commit failed");
          state.closed++;
        },
        async abort() {
          assert.ok(state.held);
          await Promise.resolve();
          assert.ok(state.held);
          state.aborted++;
          if (fault === "abort") throw new Error("abort failed");
        },
      };
    },
  };
  const folder = {
    kind: "directory",
    resolve: async () => null,
    name: "fresh",
    async *values() {},
    async getFileHandle(name, options) {
      assert.ok(state.held);
      if (!options?.create) {
        if (fault === "empty-collision") return target;
        throw new DOMException("Missing", "NotFoundError");
      }
      return target;
    },
    removeEntry() {
      assert.fail("Never delete");
    },
  };
  const destination = {
    kind: "directory",
    resolve: async () => null,
    name: "output",
    async getDirectoryHandle(name, options) {
      assert.ok(state.held);
      if (!options?.create) throw new DOMException("Missing", "NotFoundError");
      state.folders++;
      return folder;
    },
    removeEntry() {
      assert.fail("Never delete");
    },
  };
  const source = {
    kind: "directory",
    resolve: async () => null,
    async isSameEntry() {
      return fault === "same";
    },
    async resolve() {
      if (fault === "denied")
        throw new DOMException("Denied", "NotAllowedError");
      return fault === "child" ? ["child"] : null;
    },
  };
  const locks = {
    async request(name, options, run) {
      assert.equal(name, COPY_LOCK_NAME);
      assert.equal(options.mode, "exclusive");
      state.held = true;
      try {
        return await run({ name });
      } finally {
        state.held = false;
      }
    },
  };
  return {
    state,
    options: { destination, source, locks, cancelled: () => state.cancelled },
  };
}
test("classic ZIP 4 GiB minus one boundary includes exact UTF-8 ZIP headers and rejects above it", () => {
  assert.equal(DISK_ZIP_LIMIT, 4 * 1024 * 1024 * 1024 - 1);
  const name = "사진.CR3",
    overhead = 22 + 92 + new TextEncoder().encode(name).length * 2;
  assert.equal(
    zipSize([{ name, file: { size: DISK_ZIP_LIMIT - overhead } }]),
    DISK_ZIP_LIMIT,
  );
  assert.throws(
    () => zipSize([{ name, file: { size: DISK_ZIP_LIMIT - overhead + 1 } }]),
    /4GB/,
  );
  assert.throws(
    () =>
      zipSize(
        [{ name, file: { size: DOWNLOAD_ZIP_LIMIT } }],
        DOWNLOAD_ZIP_LIMIT,
      ),
    /512MB/,
  );
  assert.throws(
    () => zipSize(Array(65536).fill({ name: "a", file: { size: 0 } })),
    /65,535/,
  );
});
test("ZIP streams valid original bytes to a fresh folder and commits while holding copy lock", async () => {
  const { state, options } = fixture(),
    files = entries(),
    result = await saveZipToDirectory(files, options);
  assert.equal(result.bytes, zipSize(files));
  assert.equal(state.closed, 1);
  assert.equal(state.aborted, 0);
  assert.equal(state.held, false);
  const data = Buffer.concat(state.chunks);
  assert.equal(data.readUInt32LE(0), 0x04034b50);
  assert.equal(data.readUInt32LE(data.length - 22), 0x06054b50);
  assert.ok(data.includes(Buffer.from("jpeg original")));
  assert.ok(data.includes(Buffer.from("raw original")));
  assert.equal(await files[1].file.text(), "raw original");
});
for (const fault of ["same", "child", "denied"])
  test(`unsafe ZIP destination blocked before folder creation: ${fault}`, async () => {
    const { state, options } = fixture(fault);
    await assert.rejects(saveZipToDirectory(entries(), options));
    assert.equal(state.folders, 0);
    assert.equal(state.writes, 0);
  });
for (const fault of [
  "open",
  "write",
  "close",
  "cancel",
  "existing",
  "empty-collision",
])
  test(`ZIP ${fault} failure never commits or deletes and releases lock after cleanup`, async () => {
    const { state, options } = fixture(fault);
    await assert.rejects(saveZipToDirectory(entries(), options));
    assert.equal(state.closed, 0);
    assert.equal(state.held, false);
    if (["write", "close", "cancel"].includes(fault))
      assert.equal(state.aborted, 1);
  });
test("unavailable locks, pre-cancel and over-limit ZIP do not create folders", async () => {
  for (const variant of ["locks", "cancel", "limit"]) {
    const { state, options } = fixture();
    let files = entries();
    if (variant === "locks") options.locks = {};
    if (variant === "cancel") {
      const c = new AbortController();
      c.abort();
      options.signal = c.signal;
    }
    if (variant === "limit")
      files = [{ name: "big.CR3", file: { size: DISK_ZIP_LIMIT } }];
    await assert.rejects(saveZipToDirectory(files, options));
    assert.equal(state.folders, 0);
  }
});
test("source read failure, size mismatch and abort failure keep lock through abort", async () => {
  for (const variant of ["read", "size", "abort"]) {
    const { state, options } = fixture(variant === "abort" ? "abort" : "");
    const file = {
      size: 5,
      stream() {
        return new ReadableStream({
          start(c) {
            if (variant === "size") {
              c.enqueue(new Uint8Array(4));
              c.close();
            } else c.error(new Error("source disconnected"));
          },
        });
      },
    };
    await assert.rejects(
      saveZipToDirectory([{ name: "a.CR3", file }], options),
    );
    assert.equal(state.closed, 0);
    assert.equal(state.aborted, 1);
    assert.equal(state.held, false);
  }
});
test("600 MiB input streams past old 512 MiB limit with one small chunk at a time", async () => {
  const { state, options } = fixture("large");
  const chunk = new Uint8Array(1024 * 1024);
  let remaining = 600;
  const file = {
    size: 600 * 1024 * 1024,
    stream() {
      return new ReadableStream({
        pull(c) {
          if (remaining-- > 0) c.enqueue(chunk);
          else c.close();
        },
      });
    },
  };
  const result = await saveZipToDirectory(
    [{ name: "large.CR3", file }],
    options,
  );
  assert.equal(result.bytes, zipSize([{ name: "large.CR3", file }]));
  assert.equal(state.closed, 1);
  assert.ok(state.writes > 600);
  assert.equal(state.chunks.length, 0);
});
