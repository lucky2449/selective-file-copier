import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
test("self-hosted face detector assets match recorded hashes and include model/license notices", async () => {
  const root = new URL("../dist/vendor/mediapipe-face-1.1.1/", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", root), "utf8"),
  );
  assert.equal(manifest.version, "1.1.1");
  assert.equal(manifest.license, "Apache-2.0");
  for (const name of [
    "vision_bundle.mjs",
    "wasm/vision_wasm_module_internal.js",
    "wasm/vision_wasm_module_internal.wasm",
    "face_detector.tflite",
    "face_landmarker.task",
    "landmark-model-card.pdf",
    "blendshape-model-card.pdf",
    "model-card.pdf",
    "LICENSE.txt",
    "NOTICE.txt",
  ])
    assert.ok(manifest.files[name]);
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert.ok(!name.includes("..") && !name.startsWith("/"));
    const bytes = await readFile(new URL(name, root));
    assert.equal(bytes.length, expected.bytes, name);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected.sha256,
      name,
    );
  }
});
