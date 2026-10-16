import { openCopyWriter } from "../dist/copy-safety.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDistinctDirectories,
  createResultDirectory,
  readSourceDirectory,
  selectNativeSource,
} from "../dist/directory-access.mjs";

function directory(id, name, entries = []) {
  return {
    kind: "directory",
    name,
    id,
    async isSameEntry(other) {
      return id === other.id;
    },
    async resolve() {
      return null;
    },
    async *values() {
      yield* entries;
    },
  };
}
function file(name, content = "data") {
  const blob = new Blob([content]);
  return {
    kind: "file",
    name,
    async getFile() {
      return blob;
    },
    blob,
  };
}

test("same underlying folder is rejected even through separate handles", async () => {
  const source = directory("photos", "original");
  const alias = directory("photos", "renamed-display");
  await assert.rejects(
    assertDistinctDirectories(source, alias),
    /원본 폴더와 저장 폴더가 같습니다/,
  );
});

test("different folders with the same display name remain allowed", async () => {
  await assertDistinctDirectories(
    directory("disk-a", "photos"),
    directory("disk-b", "photos"),
  );
});

test("missing, unverified, or file handles cannot bypass directory checks", async () => {
  const target = directory("target", "target");
  for (const source of [
    null,
    { kind: "directory", name: "photos" },
    { kind: "file", isSameEntry: async () => false },
  ]) {
    await assert.rejects(
      assertDistinctDirectories(source, target),
      /원본을 다시 선택/,
    );
  }
  await assert.rejects(
    assertDistinctDirectories(target, null),
    /저장 폴더를 다시 선택/,
  );
});

test("identity comparison failures propagate instead of permitting copying", async () => {
  const source = directory("source", "source");
  source.isSameEntry = async () => {
    throw new DOMException("Permission revoked", "NotAllowedError");
  };
  await assert.rejects(
    assertDistinctDirectories(source, directory("target", "target")),
    { name: "NotAllowedError" },
  );
});

test("native source scan retains file bytes and relative subfolder paths", async () => {
  const photo = file("photo.jpg"),
    raw = file("photo.cr3");
  const source = directory("source", "사진", [
    photo,
    directory("sub", "day1", [raw]),
  ]);
  const files = await readSourceDirectory(source);
  assert.deepEqual(
    files.map((entry) => entry.path),
    ["사진/photo.jpg", "사진/day1/photo.cr3"],
  );
  assert.equal(files[0].file, photo.blob);
  assert.equal(files[1].file, raw.blob);
});

test("native chooser runs during the click and preserves the actual source handle", async () => {
  let active = true,
    scanning = false;
  const source = directory("source", "photos", [file("photo.jpg")]);
  const pending = selectNativeSource(
    (options) => {
      assert.equal(active, true);
      assert.deepEqual(options, { mode: "read" });
      return Promise.resolve(source);
    },
    {
      onScanning: () => {
        scanning = true;
      },
    },
  );
  active = false;
  const selection = await pending;
  assert.equal(selection.handle, source);
  assert.equal(selection.name, "photos");
  assert.equal(selection.files.length, 1);
  assert.equal(scanning, true);
});

test("cancelled chooser does not start a scan or accept a replacement source", async () => {
  let scanning = false;
  await assert.rejects(
    selectNativeSource(
      async () => {
        throw new DOMException("Cancelled", "AbortError");
      },
      {
        onScanning: () => {
          scanning = true;
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(scanning, false);
});

test("cancelled or unreadable native scans return no partial selection", async () => {
  const source = directory("source", "photos", [file("photo.jpg")]);
  await assert.rejects(readSourceDirectory(source, { cancelled: () => true }), {
    name: "AbortError",
  });
  const badFile = file("missing.jpg");
  badFile.getFile = async () => {
    throw new DOMException("Missing", "NotFoundError");
  };
  await assert.rejects(
    readSourceDirectory(
      directory("source", "photos", [file("ok.jpg"), badFile]),
    ),
    { name: "NotFoundError" },
  );
});

test("native handles without identity support cannot enable direct copying", async () => {
  let scanning = false;
  await assert.rejects(
    selectNativeSource(async () => ({ kind: "directory", name: "photos" }), {
      onScanning: () => {
        scanning = true;
      },
    }),
    /동일 여부를 확인할 수 없습니다/,
  );
  assert.equal(scanning, false);
});

test("result folders never reuse existing folders or files and stop on denied access or cancellation", async () => {
  let creations = 0,
    candidate = 0;
  const parent = {
    kind: "directory",
    async getDirectoryHandle(name, options) {
      if (options?.create) {
        creations++;
        return directory(name, name);
      }
      if (name === "candidate-0") return directory("existing", name);
      if (name === "candidate-1")
        throw new DOMException("File collision", "TypeMismatchError");
      throw new DOMException("Missing", "NotFoundError");
    },
  };
  const result = await createResultDirectory(parent, {
    makeName: () => `candidate-${candidate++}`,
  });
  assert.equal(result.name, "candidate-2");
  assert.equal(creations, 1);
  await assert.rejects(
    createResultDirectory(parent, { cancelled: () => true }),
    { name: "AbortError" },
  );
  assert.equal(creations, 1);
  parent.getDirectoryHandle = async () => {
    throw new DOMException("Denied", "NotAllowedError");
  };
  await assert.rejects(createResultDirectory(parent), {
    name: "NotAllowedError",
  });
  await assert.rejects(createResultDirectory(null), /저장 폴더를 다시 선택/);
});

test("source descendants and unverifiable containment are blocked", async () => {
  const source = directory("source", "source");
  const child = directory("child", "child");
  source.resolve = async () => ["child"];
  await assert.rejects(
    assertDistinctDirectories(source, child),
    /원본 폴더 안/,
  );
  delete source.resolve;
  await assert.rejects(
    assertDistinctDirectories(source, child),
    /확인할 수 없어/,
  );
  source.resolve = async () => {
    throw new DOMException("Denied", "NotAllowedError");
  };
  await assert.rejects(assertDistinctDirectories(source, child), {
    name: "NotAllowedError",
  });
});

test("a nonempty directory appearing during result creation is never reused or removed", async () => {
  const existing = directory("existing", "existing", [file("original.jpg")]);
  const parent = {
    kind: "directory",
    async getDirectoryHandle(name, options) {
      if (!options?.create) throw new DOMException("Missing", "NotFoundError");
      return existing;
    },
    removeEntry: () => assert.fail("Never remove an existing directory"),
  };
  await assert.rejects(createResultDirectory(parent), /기존 항목/);
  const [original] = await readSourceDirectory(existing);
  assert.equal(await original.file.text(), "data");
});

function outputTarget() {
  const state = {
    size: 0,
    lastModified: 1,
    opened: 0,
    writes: 0,
    closes: 0,
    aborts: 0,
  };
  const handle = {
    getFile: async () => ({
      size: state.size,
      lastModified: state.lastModified,
    }),
    async createWritable(options) {
      assert.deepEqual(options, { mode: "exclusive" });
      state.opened++;
      return {
        write: async () => {
          state.writes++;
        },
        close: async () => {
          state.closes++;
        },
        abort: async () => {
          state.aborts++;
        },
      };
    },
  };
  const directory = {
    async getFileHandle(name, options) {
      assert.deepEqual(options, { create: true });
      return handle;
    },
    removeEntry: () => assert.fail("Never delete an output on failure"),
  };
  return { state, handle, directory };
}

test("writing is refused when a created handle resolves to an original, including an empty original", async () => {
  const target = outputTarget();
  const source = { resolve: async () => ["original.jpg"] };
  await assert.rejects(
    openCopyWriter(target.directory, "original.jpg", { source }),
    /원본 폴더 안/,
  );
  assert.equal(target.state.opened, 0);
  source.resolve = async () => {
    throw new DOMException("Denied", "NotAllowedError");
  };
  await assert.rejects(
    openCopyWriter(target.directory, "photo.jpg", { source }),
    { name: "NotAllowedError" },
  );
  assert.equal(target.state.opened, 0);
});

test("changes detected after writer creation abort without writes or deletion", async () => {
  const target = outputTarget();
  const open = target.handle.createWritable;
  target.handle.createWritable = async (options) => {
    const writer = await open(options);
    target.state.size = 12;
    return writer;
  };
  await assert.rejects(
    openCopyWriter(target.directory, "photo.jpg"),
    /외부 변경/,
  );
  assert.equal(target.state.writes, 0);
  assert.equal(target.state.closes, 0);
  assert.equal(target.state.aborts, 1);
});

test("external metadata changes and cancellation prevent committing staged bytes", async () => {
  for (const reason of ["size", "timestamp", "source", "cancel"]) {
    const target = outputTarget();
    let cancelled = false,
      insideSource = false;
    const writer = await openCopyWriter(target.directory, "photo.jpg", {
      cancelled: () => cancelled,
      source: { resolve: async () => (insideSource ? ["photo.jpg"] : null) },
    });
    await writer.write(new Uint8Array([1, 2, 3]));
    if (reason === "size") target.state.size = 3;
    if (reason === "timestamp") target.state.lastModified++;
    if (reason === "source") insideSource = true;
    if (reason === "cancel") cancelled = true;
    await assert.rejects(writer.close());
    await writer.abort();
    assert.equal(target.state.closes, 0);
    assert.equal(target.state.aborts, 1);
  }
});

test("a new unchanged output commits successfully and never needs cleanup deletion", async () => {
  const target = outputTarget();
  const writer = await openCopyWriter(target.directory, "photo.jpg");
  await writer.write(new Uint8Array([1, 2, 3]));
  await writer.close();
  assert.equal(target.state.writes, 1);
  assert.equal(target.state.closes, 1);
  assert.equal(target.state.aborts, 0);
});

test("result folder dates follow the device timezone at midnight and year rollover, using compact time names", async () => {
  const { execFileSync } = await import("node:child_process");
  const moduleUrl = new URL("../dist/directory-access.mjs", import.meta.url)
    .href;
  const instants = [
    "2026-10-15T14:59:59Z",
    "2026-10-15T15:00:00Z",
    "2026-12-31T15:00:00Z",
    "2026-10-16T00:30:00Z",
  ];
  for (const [timezone, expected] of [
    ["Asia/Seoul", ["2026-10-15", "2026-10-16", "2027-01-01", "2026-10-16"]],
    ["UTC", ["2026-10-15", "2026-10-15", "2026-12-31", "2026-10-16"]],
    [
      "America/Los_Angeles",
      ["2026-10-15", "2026-10-15", "2026-12-31", "2026-10-15"],
    ],
  ]) {
    const code = `import {makeResultDirectoryName} from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(${JSON.stringify(instants)}.map(value => [makeResultDirectoryName(new Date(value)), makeResultDirectoryName(new Date(value))])));`;
    const pairs = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", code], {
        encoding: "utf8",
        env: { ...process.env, TZ: timezone },
      }),
    );
    pairs.forEach(([first, second], i) => {
      assert.ok(
        first.startsWith(`${expected[i].replaceAll("-", "")}_`),
        `${timezone}: ${first}`,
      );
      assert.match(first, /^\d{8}_\d{6}$/);
      const times = {
        "Asia/Seoul": ["235959", "000000", "000000", "093000"],
        UTC: ["145959", "150000", "150000", "003000"],
        "America/Los_Angeles": ["075959", "080000", "070000", "173000"],
      };
      assert.equal(
        first,
        `${expected[i].replaceAll("-", "")}_${times[timezone][i]}`,
      );
      assert.equal(first, second);
    });
  }
});

test("same timestamp copies use numbered fresh folders and skip existing files without deleting anything", async () => {
  const base = "20261016_143025";
  const existing = new Map([
    [base, directory("existing", base)],
    [`${base}_2`, "file"],
  ]);
  const created = [];
  const parent = {
    kind: "directory",
    async getDirectoryHandle(name, options) {
      if (existing.has(name)) {
        if (existing.get(name) === "file")
          throw new DOMException("File", "TypeMismatchError");
        return existing.get(name);
      }
      if (!options?.create) throw new DOMException("Missing", "NotFoundError");
      const output = directory(name, name);
      existing.set(name, output);
      created.push(name);
      return output;
    },
    removeEntry() {
      assert.fail("Never delete existing entries");
    },
  };
  const first = await createResultDirectory(parent, { makeName: () => base });
  const second = await createResultDirectory(parent, { makeName: () => base });
  assert.equal(first.name, `${base}_3`);
  assert.equal(second.name, `${base}_4`);
  assert.deepEqual(created, [`${base}_3`, `${base}_4`]);
  assert.equal(existing.get(base).id, "existing");
  assert.equal(existing.get(`${base}_2`), "file");
});
