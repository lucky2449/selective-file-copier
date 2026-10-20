import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const vendor = new URL(
  "../dist/vendor/libraw-nothread-1.6.0-1/",
  import.meta.url,
);
const hash = (b) => createHash("sha256").update(b).digest("hex");
test("RAW vendor files match pinned provenance hashes including source distribution", async () => {
  const m = JSON.parse(
    await readFile(new URL("manifest.json", vendor), "utf8"),
  );
  assert.equal(m.package, "libraw-wasm-nothread");
  assert.equal(m.version, "1.6.0-nothread.1");
  assert.equal(
    m.sources.LibRaw.commit,
    "b860248a89d9082b8e0a1e202e516f46af9adb29",
  );
  assert.equal(
    m.sources["Little-CMS"].commit,
    "21c582a594fe5279f90c0b93437c398f93bf62b0",
  );
  assert.equal(m.independentlyRebuilt, false);
  for (const [name, expected] of Object.entries(m.files)) {
    assert.ok(!name.includes("/") && !name.includes(".."));
    assert.equal(hash(await readFile(new URL(name, vendor))), expected, name);
  }
  assert.ok(m.files["source-bundle.zip"]);
  assert.deepEqual(
    (await readdir(vendor)).sort(),
    [...Object.keys(m.files), "manifest.json"].sort(),
  );
});
test("RAW source ZIP preserves CDDL source and modified build configuration", async () => {
  const bytes = await readFile(new URL("source-bundle.zip", vendor));
  const entries = [];
  let pos = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(pos), 0x06054b50);
  const count = bytes.readUInt16LE(pos + 10);
  pos = bytes.readUInt32LE(pos + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(pos), 0x02014b50);
    const n = bytes.readUInt16LE(pos + 28),
      extra = bytes.readUInt16LE(pos + 30),
      comment = bytes.readUInt16LE(pos + 32);
    entries.push(bytes.toString("utf8", pos + 46, pos + 46 + n));
    pos += 46 + n + extra + comment;
  }
  for (const name of [
    "sources/LibRaw.tar.gz",
    "sources/Little-CMS.tar.gz",
    "sources/libraw-wasm-nothread.tar.gz",
    "modified/LibRaw/configure.ac",
    "libraw_wrapper.cpp",
    "upstream-build.sh",
    "licenses/LibRaw-LICENSE.CDDL.txt",
    "licenses/LibRaw-Wasm-ISC.txt",
    "licenses/Little-CMS-MIT.txt",
    "licenses/IJG-JPEG-README.txt",
    "licenses/libpng-LICENSE.txt",
    "licenses/zlib-LICENSE.txt",
  ])
    assert.ok(entries.includes(name), name);
});
test("license notice and free source download remain reachable from the published UI", async () => {
  const html = await readFile(
    new URL("../dist/index.html", import.meta.url),
    "utf8",
  );
  assert.match(html, /href="\.\/licenses.html"/);
  const page = await readFile(
    new URL("../dist/licenses.html", import.meta.url),
    "utf8",
  );
  for (const [, href] of page.matchAll(/href="(\.\/[^"#]+)"/g))
    if (!href.endsWith("/"))
      await readFile(new URL("../dist/" + href.slice(2), import.meta.url));
  assert.match(page, /source-bundle\.zip/);
  assert.match(page, /CDDL 1\.0/);
  const worker = await readFile(
    new URL("../dist/raw-convert-worker.mjs", import.meta.url),
    "utf8",
  );
  assert.match(worker, /vendor\/libraw-nothread-1\.6\.0-1\/libraw.js/);
});
test("browser RAW build uses valid WASM without a SharedArrayBuffer JS requirement", async () => {
  assert.ok(
    WebAssembly.validate(await readFile(new URL("libraw.wasm", vendor))),
  );
  const js = await readFile(new URL("libraw.js", vendor), "utf8");
  assert.ok(!js.includes("SharedArrayBuffer"));
});
