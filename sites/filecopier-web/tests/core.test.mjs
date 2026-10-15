import assert from "node:assert/strict";
import test from "node:test";
import {
  parseItems,
  isExcludedFile,
  buildIndex,
  matchItem,
  uniqueName,
  selectedFiles,
} from "../dist/core.mjs";
import { writeZip } from "../dist/zip.mjs";

const files = [
  "root/a/DSC00323.JPG",
  "root/b/DSC00323.JPG",
  "root/DSC123456.jpg",
  "root/1234.jpg",
  "root/A1B2C.jpg",
  "root/IMG_001.cr3",
  "root/IMG_001.jpg",
  "root/my photo.jpg",
].map((path) => ({ path, name: path.split("/").at(-1) }));
const index = buildIndex(files);

test("parse lists, quoted separators, BOM, paths and duplicates", () => {
  assert.deepEqual(
    parseItems('323, 2134\na.jpg, b.jpg\n"my photo"\n1 / 10 / 13\n323'),
    ["323", "2134", "a.jpg", "b.jpg", "my photo", "1", "10", "13"],
  );
  assert.deepEqual(
    parseItems('\uFEFF"photo, summer.jpg"\nC:\\photos\\hello world.jpg'),
    ["photo, summer.jpg", "C:\\photos\\hello world.jpg"],
  );
});

test("numeric matching compares the entire trailing numeric ID", () => {
  for (const item of ["23", "23456", "12"])
    assert.equal(matchItem(index, item).candidates.length, 0);
  assert.equal(matchItem(index, "123456").chosen.name, "DSC123456.jpg");
  assert.equal(matchItem(index, "00323").candidates.length, 2);
  assert.equal(matchItem(index, "00323").chosen, null);
});

test("match case-insensitive paths and names without picking ambiguous files", () => {
  assert.equal(
    matchItem(index, "C:\\root\\a\\DSC00323.JPG").chosen.path,
    "root/a/DSC00323.JPG",
  );
  assert.equal(matchItem(index, "my photo.jpg").chosen.name, "my photo.jpg");
  assert.equal(matchItem(index, "dsc00323.jpg").candidates.length, 2);
  assert.equal(matchItem(index, "dsc00323.jpg").chosen, null);
});

test("extension filters also apply to JPG-to-RAW and path searches", () => {
  const rawIndex = buildIndex(files, ".cr3");
  assert.equal(matchItem(rawIndex, "IMG_001.jpg").chosen.name, "IMG_001.cr3");
  assert.equal(
    matchItem(rawIndex, "root/IMG_001.jpg").chosen.name,
    "IMG_001.cr3",
  );
});

test("rename colliding output names and copy the same source only once", () => {
  const occupied = new Set(["file.jpg", "file_1.jpg"]);
  assert.equal(uniqueName("FILE.jpg", occupied), "FILE_2.jpg");
  const chosen = matchItem(index, "123456");
  assert.equal(selectedFiles([chosen, chosen]).length, 1);
});

test("ZIP contains UTF-8 names, original bytes, valid CRCs and central directory", async () => {
  const parts = [];
  const entries = [
    {
      name: "한글 파일.txt",
      bytes: new TextEncoder().encode("123456789"),
      crc: 0xcbf43926,
    },
    { name: "empty.txt", bytes: new Uint8Array(), crc: 0 },
  ];
  await writeZip(
    entries.map((entry) => ({
      name: entry.name,
      file: new Blob([entry.bytes]),
    })),
    { write: async (bytes) => parts.push(bytes) },
  );
  const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();
  const offsets = [];
  let offset = 0;
  for (const entry of entries) {
    offsets.push(offset);
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    assert.equal(view.getUint16(offset + 6, true), 0x808); // UTF-8 and data descriptor.
    assert.equal(view.getUint16(offset + 8, true), 0); // Stored, not compressed.
    const nameLength = view.getUint16(offset + 26, true);
    const dataStart = offset + 30 + nameLength;
    assert.equal(
      decoder.decode(bytes.subarray(offset + 30, dataStart)),
      entry.name,
    );
    assert.deepEqual(
      bytes.slice(dataStart, dataStart + entry.bytes.length),
      entry.bytes,
    );
    offset = dataStart + entry.bytes.length;
    assert.equal(view.getUint32(offset, true), 0x08074b50);
    assert.equal(view.getUint32(offset + 4, true), entry.crc);
    assert.equal(view.getUint32(offset + 8, true), entry.bytes.length);
    assert.equal(view.getUint32(offset + 12, true), entry.bytes.length);
    offset += 16;
  }
  const centralStart = offset;
  for (const [i, entry] of entries.entries()) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    assert.equal(view.getUint32(offset + 16, true), entry.crc);
    assert.equal(view.getUint32(offset + 42, true), offsets[i]);
    const nameLength = view.getUint16(offset + 28, true);
    assert.equal(
      decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      entry.name,
    );
    offset += 46 + nameLength;
  }
  assert.equal(view.getUint32(offset, true), 0x06054b50);
  assert.equal(view.getUint16(offset + 8, true), entries.length);
  assert.equal(view.getUint16(offset + 10, true), entries.length);
  assert.equal(view.getUint32(offset + 12, true), offset - centralStart);
  assert.equal(view.getUint32(offset + 16, true), centralStart);
  assert.equal(offset + 22, bytes.length);
});

test("ZIP cancellation stops subsequent writes", async () => {
  let writes = 0;
  await assert.rejects(
    writeZip(
      [{ name: "cancel.txt", file: new Blob(["hello"]) }],
      {
        write: async () => {
          writes++;
        },
      },
      { cancelled: () => writes > 0 },
    ),
    { name: "AbortError" },
  );
  assert.equal(writes, 1);
});

test("ZIP rejects files and entry counts beyond non-ZIP64 limits", async () => {
  const sink = { write: async () => {} };
  await assert.rejects(
    writeZip([{ name: "large.bin", file: { size: 0x100000000 } }], sink),
    /4GB/,
  );
  await assert.rejects(writeZip(new Array(65536), sink), /65,535/);
});


test("exclude Zone.Identifier sidecars from matching and every output selection", () => {
  const names = [
    "Zone.Identifier", "photo.jpg.Zone.Identifier", "photo.JPG.ZONE.IDENTIFIER",
    "photo.jpg:Zone.Identifier", "photo.jpg:Zone.Identifier:$DATA",
  ];
  const sidecars = names.map((name) => ({ name, path: `root/${name}` }));
  const photo = { name: "photo.jpg", path: "root/photo.jpg" };
  const safeIndex = buildIndex([photo, ...sidecars]);
  for (const file of sidecars) {
    assert.equal(isExcludedFile(file.name), true);
    assert.equal(matchItem(safeIndex, file.name).chosen, null);
    assert.equal(matchItem(safeIndex, file.path).candidates.length, 0);
  }
  assert.deepEqual([...safeIndex.names.keys()], ["photo.jpg"]);
  assert.equal(matchItem(safeIndex, "photo.jpg").chosen, photo);
  assert.equal(isExcludedFile("Zone.Identifier.jpg"), false);
  assert.equal(isExcludedFile("photo.identifier"), false);
  assert.deepEqual(selectedFiles([photo, ...sidecars].map((chosen) => ({
    chosen, selected: true,
  }))), [photo]);
});
