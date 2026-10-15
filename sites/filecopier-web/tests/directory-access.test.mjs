import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDistinctDirectories,
  createCopyDirectory,
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

test("automatic output folders use local date/time and avoid file and folder collisions", async () => {
  const now = new Date(2026, 9, 15, 13, 4, 5);
  const base = "파일모아_20261015_130405";
  const source = directory("source", "source");
  const parent = directory("downloads", "Downloads", [
    directory("old", base),
    file(`${base}_1`),
  ]);
  const calls = [];
  parent.getDirectoryHandle = async (name, options) => {
    calls.push([name, options]);
    if (!options?.create) {
      if (name === `${base}_2`) return directory("raced", name);
      if (name === `${base}_3`)
        throw new DOMException("File appeared", "TypeMismatchError");
      throw new DOMException("Missing", "NotFoundError");
    }
    return directory("new", name);
  };
  const output = await createCopyDirectory(source, parent, { now });
  assert.equal(output.name, `${base}_4`);
  assert.deepEqual(calls.at(-1), [`${base}_4`, { create: true }]);
  assert.equal(calls.filter(([, options]) => options?.create).length, 1);
});

test("automatic folder creation rejects same source and propagates denied access", async () => {
  const source = directory("source", "source");
  source.getDirectoryHandle = () =>
    assert.fail("Must not create inside rejected source");
  await assert.rejects(
    createCopyDirectory(source, source),
    /원본 폴더와 저장 폴더가 같습니다/,
  );
  const parent = directory("downloads", "Downloads");
  let creations = 0;
  parent.getDirectoryHandle = async (_, options) => {
    if (options?.create) creations++;
    throw new DOMException("Denied", "NotAllowedError");
  };
  await assert.rejects(createCopyDirectory(source, parent), {
    name: "NotAllowedError",
  });
  assert.equal(creations, 0);
});

test("cancelled automatic folder preparation creates no directory", async () => {
  const source = directory("source", "source");
  const parent = directory("downloads", "Downloads");
  parent.getDirectoryHandle = () =>
    assert.fail("Cancelled job must not create a directory");
  await assert.rejects(
    createCopyDirectory(source, parent, { cancelled: () => true }),
    { name: "AbortError" },
  );
  let cancelled = false;
  parent.values = async function* () {
    cancelled = true;
    yield file("existing.jpg");
  };
  await assert.rejects(
    createCopyDirectory(source, parent, { cancelled: () => cancelled }),
    { name: "AbortError" },
  );
});
