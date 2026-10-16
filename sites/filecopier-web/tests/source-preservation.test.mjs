import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { openCopyWriter } from "../dist/copy-safety.mjs";
import {
  assertDistinctDirectories,
  createResultDirectory,
  readSourceDirectory,
} from "../dist/directory-access.mjs";
import { writeZip } from "../dist/zip.mjs";

// Real disk fixtures with a File System Access adapter, not a browser API emulator.
// Faults are injected deterministically; actual browser permissions/USB are separate QA.
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function snapshot(root) {
  const result = {};
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name),
        stat = await fs.stat(name);
      result[path.relative(root, name)] = {
        kind: entry.isDirectory() ? "directory" : "file",
        size: entry.isDirectory() ? undefined : stat.size,
        mtime: stat.mtimeMs,
        birthtime: stat.birthtimeMs,
        mode: stat.mode,
        hash: entry.isDirectory() ? undefined : digest(await fs.readFile(name)),
      };
      if (entry.isDirectory()) await visit(name);
    }
  }
  await visit(root);
  return result;
}
function handle(location, fault = {}, audit = []) {
  return {
    kind: "directory",
    name: path.basename(location),
    location,
    async isSameEntry(other) {
      return location === other.location;
    },
    async resolve(other) {
      if (fault.resolve)
        throw new DOMException("Permission revoked", "NotAllowedError");
      const relative = path.relative(location, other.location);
      return relative === ""
        ? []
        : relative.startsWith(".." + path.sep) ||
            relative === ".." ||
            path.isAbsolute(relative)
          ? null
          : relative.split(path.sep);
    },
    async *values() {
      for (const entry of await fs.readdir(location, { withFileTypes: true })) {
        const next = path.join(location, entry.name);
        yield entry.isDirectory()
          ? handle(next, fault, audit)
          : fileHandle(next, fault, audit);
      }
    },
    async getDirectoryHandle(name, options) {
      const next = path.join(location, name);
      try {
        if (!(await fs.stat(next)).isDirectory())
          throw new DOMException("File", "TypeMismatchError");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!options?.create)
          throw new DOMException("Missing", "NotFoundError");
        audit.push(["mkdir", next]);
        await fs.mkdir(next);
      }
      return handle(next, fault, audit);
    },
    async getFileHandle(name, options) {
      const next = path.join(location, name);
      try {
        if (!(await fs.stat(next)).isFile())
          throw new DOMException("Directory", "TypeMismatchError");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!options?.create)
          throw new DOMException("Missing", "NotFoundError");
        audit.push(["create", next]);
        await fs.writeFile(next, new Uint8Array(), { flag: "wx" });
      }
      return fileHandle(next, fault, audit);
    },
    removeEntry() {
      assert.fail("Deletion must never be requested");
    },
  };
}
function fileHandle(location, fault, audit) {
  return {
    kind: "file",
    name: path.basename(location),
    location,
    async getFile() {
      if (fault.read)
        throw new DOMException("Read failure", "NotReadableError");
      const stat = await fs.stat(location);
      return new File([await fs.readFile(location)], path.basename(location), {
        lastModified: stat.mtimeMs,
      });
    },
    async createWritable(options) {
      assert.deepEqual(options, { mode: "exclusive" });
      audit.push(["open", location]);
      if (fault.open)
        throw new DOMException("Permission revoked", "NotAllowedError");
      const parts = [];
      return {
        async write(bytes) {
          if (fault.write)
            throw new DOMException("Disk full", "QuotaExceededError");
          parts.push(bytes);
          await fault.afterWrite?.();
        },
        async close() {
          if (fault.close) throw new Error("Commit failed");
          audit.push(["commit", location]);
          await fs.writeFile(location, Buffer.concat(parts));
        },
        async abort() {
          parts.length = 0;
          if (fault.abort) throw new Error("Abort failed");
        },
      };
    },
    move() {
      assert.fail("Move must never be requested");
    },
    remove() {
      assert.fail("Removal must never be requested");
    },
  };
}
async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "filemoa-source-safety-"),
  );
  t.after(async () => {
    // Only this test's newly created temp directory may be recursively removed.
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("filemoa-source-safety-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const sourcePath = path.join(root, "source"),
    outputPath = path.join(root, "output");
  await fs.mkdir(path.join(sourcePath, "A"), { recursive: true });
  await fs.mkdir(path.join(sourcePath, "B"), { recursive: true });
  await fs.mkdir(outputPath);
  const entries = new Map([
    ["A/IMG_0001.JPG", Buffer.from("JPEG original")],
    ["A/IMG_0001.CR3", Buffer.alloc(131073, 179)],
    ["B/IMG_0001.JPG", Buffer.from("different original")],
    ["B/사진 빈 파일.NEF", Buffer.alloc(0)],
    ["A/IMG_0001.XMP", Buffer.from("sidecar original")],
    ["A/IMG_0001.JPG.Zone.Identifier", Buffer.from("zone metadata")],
  ]);
  for (const [name, bytes] of entries) {
    const p = path.join(sourcePath, name);
    await fs.writeFile(p, bytes);
    await fs.utimes(
      p,
      new Date("2020-01-02T03:04:05Z"),
      new Date("2020-01-02T03:04:05Z"),
    );
  }
  const before = await snapshot(sourcePath),
    audit = [];
  return {
    root,
    sourcePath,
    outputPath,
    audit,
    before,
    source: handle(sourcePath, {}, audit),
  };
}

// Compare before test-only cleanup, including when a tested operation fails.
async function verified(t, run) {
  const f = await fixture(t);
  try {
    await run(f);
  } finally {
    assert.deepEqual(await snapshot(f.sourcePath), f.before);
    assert.ok(f.audit.every(([, p]) => !p.startsWith(f.sourcePath + path.sep)));
  }
}
for (const scenario of [
  "success",
  "open",
  "write",
  "close",
  "abort",
  "cancel",
  "cancel-before",
  "read-stream",
  "permission-before-close",
  "target-change",
]) {
  test(`disk source snapshot is unchanged: ${scenario}`, async (t) =>
    verified(t, async (f) => {
      const files = await readSourceDirectory(f.source);
      let cancelled = scenario === "cancel-before";
      const fault = { [scenario]: true };
      if (scenario === "abort") fault.write = true;
      if (scenario === "cancel")
        fault.afterWrite = () => {
          cancelled = true;
        };
      const parent = handle(f.outputPath, fault, f.audit);
      await assertDistinctDirectories(f.source, parent);
      if (cancelled) {
        await assert.rejects(
          createResultDirectory(parent, { cancelled: () => cancelled }),
          { name: "AbortError" },
        );
        assert.equal(f.audit.length, 0);
        return;
      }
      const dest = await createResultDirectory(parent, {
        makeName: () => "20261016_120000",
      });
      let writer;
      const execute = async () => {
        const item = files.find((x) => x.name.endsWith(".CR3"));
        writer = await openCopyWriter(dest, item.name, {
          source: f.source,
          cancelled: () => cancelled,
        });
        if (scenario === "read-stream")
          throw new DOMException("Source disconnected", "NotReadableError");
        for await (const chunk of item.file.stream()) {
          if (cancelled) throw new DOMException("Cancelled", "AbortError");
          await writer.write(chunk);
        }
        if (scenario === "permission-before-close")
          f.source.resolve = async () => {
            throw new DOMException("Revoked", "NotAllowedError");
          };
        if (scenario === "target-change")
          await fs.writeFile(
            path.join(dest.location, item.name),
            "external destination data",
          );
        await writer.close();
        assert.equal(
          digest(await fs.readFile(path.join(dest.location, item.name))),
          digest(await fs.readFile(path.join(f.sourcePath, "A", item.name))),
        );
      };
      try {
        if (scenario === "success") await execute();
        else await assert.rejects(execute());
      } finally {
        if (scenario !== "success" && writer)
          await writer.abort().catch(() => {});
      }
      if (scenario !== "success")
        assert.equal(f.audit.filter(([op]) => op === "commit").length, 0);
      if (scenario === "target-change")
        assert.equal(
          await fs.readFile(path.join(dest.location, "IMG_0001.CR3"), "utf8"),
          "external destination data",
        );
    }));
}
for (const relationship of ["same", "child", "unverifiable"]) {
  test(`source location rejected without writes: ${relationship}`, async (t) =>
    verified(t, async (f) => {
      const dest = handle(
        relationship === "child" ? path.join(f.sourcePath, "A") : f.sourcePath,
        {},
        f.audit,
      );
      if (relationship === "unverifiable") f.source.resolve = undefined;
      await assert.rejects(assertDistinctDirectories(f.source, dest));
      await assert.rejects(
        openCopyWriter(dest, "new-file.jpg", { source: f.source }),
      );
      assert.equal(
        f.audit.length,
        0,
        "Even an empty file must not be added to the source",
      );
    }));
}
test("read scan failure and ZIP success/cancellation never mutate disk originals", async (t) =>
  verified(t, async (f) => {
    await assert.rejects(
      readSourceDirectory(handle(f.sourcePath, { read: true }, f.audit)),
      { name: "NotReadableError" },
    );
    await assert.rejects(
      readSourceDirectory(f.source, { cancelled: () => true }),
      { name: "AbortError" },
    );
    const entries = await readSourceDirectory(f.source),
      parts = [];
    await writeZip(entries, { write: async (bytes) => parts.push(bytes) });
    assert.ok(Buffer.concat(parts).length > 131073);
    let cancelled = false;
    await assert.rejects(
      writeZip(
        entries,
        {
          write: async () => {
            cancelled = true;
          },
        },
        { cancelled: () => cancelled },
      ),
      { name: "AbortError" },
    );
    assert.equal(f.audit.length, 0);
  }));
