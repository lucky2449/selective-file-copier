import assert from "node:assert/strict";
import test from "node:test";

class Element {
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  files = [];
  dataset = {};
  children = [];
  handlers = new Map();
  addEventListener(type, handler) {
    this.handlers.set(type, handler);
  }
  async fire(type) {
    return this.handlers.get(type)?.({ target: this });
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  querySelectorAll() {
    return [];
  }
  setAttribute() {}
  remove() {
    this.removed = true;
  }
  click() {
    return this.fire("click");
  }
}
let scenario = 0;
async function setup(window = {}, onDownload = () => {}) {
  const keys = [
    "document",
    "window",
    "Option",
    "setTimeout",
    "clearTimeout",
    "URL",
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, globalThis[key]]),
  );
  const elements = new Map(),
    blobs = new Map(),
    downloads = [],
    revoked = [],
    cleanup = [];
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let nextUrl = 0;
  globalThis.URL = {
    createObjectURL(blob) {
      const url = `blob:test-${nextUrl++}`;
      blobs.set(url, blob);
      return url;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };
  globalThis.document = {
    getElementById: el,
    createElement(tag) {
      const node = new Element();
      if (tag === "a")
        node.click = () => {
          onDownload(node, el);
          downloads.push({
            name: node.download,
            blob: blobs.get(node.href),
            node,
          });
        };
      return node;
    },
    createDocumentFragment: () => new Element(),
    body: new Element(),
    head: new Element(),
  };
  // App fixtures model one successful lock holder; shared scheduling is tested separately.
  if (!Object.hasOwn(window, "navigator"))
    window.navigator = {
      locks: {
        async request(name, { signal }, task) {
          if (signal?.aborted)
            throw new DOMException("Cancelled", "AbortError");
          return task({ name, mode: "exclusive" });
        },
      },
    };
  globalThis.window = window;
  globalThis.Option = class {
    constructor(text, value) {
      this.text = text;
      this.value = value;
    }
  };
  globalThis.setTimeout = (callback, ms) => {
    if (ms <= 250) queueMicrotask(callback);
    if (ms === 60000) cleanup.push(callback);
    return 1;
  };
  globalThis.clearTimeout = () => {};
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
  try {
    await import(`../dist/app.mjs?scenario=${scenario++}`);
  } catch (error) {
    restore();
    throw error;
  }
  return { el, downloads, revoked, cleanup, restore };
}
function inputFile(path, bytes = "photo") {
  return Object.assign(new Blob([bytes]), {
    name: path.split("/").at(-1),
    webkitRelativePath: path,
  });
}
async function selectExtensions(el, extensions) {
  el("extension-all").checked = extensions === "";
  await el("extension-all").fire("change");
  if (extensions === "") return;
  for (const ext of Array.isArray(extensions) ? extensions : [extensions]) {
    const input = el("extension-options")
      .children.map((label) => label.children[0])
      .find((input) => input.value === ext);
    assert.ok(input, `Missing extension checkbox ${ext}`);
    input.checked = true;
    await input.fire("change");
  }
}
async function searchInput(el, files, items, extension = "") {
  el("folder-input").files = files;
  await el("folder-input").fire("change");
  if (extension !== null) await selectExtensions(el, extension);
  el("items").value = items;
  await el("search").fire("click");
}

test("default downloads original files with unique names, no directory or ZIP picker, and no false save confirmation", async () => {
  const h = await setup({
    showDirectoryPicker: () =>
      assert.fail("Default download must never request folder access"),
    showSaveFilePicker: () =>
      assert.fail("Default download must never request ZIP access"),
  });
  const { el, downloads, cleanup, revoked } = h;
  try {
    const first = inputFile("source/a/photo.jpg", "first"),
      second = inputFile("source/b/photo.jpg", "second");
    let sourceClicks = 0;
    el("folder-input").click = () => {
      sourceClicks++;
    };
    await el("source").fire("click");
    assert.equal(
      sourceClicks,
      1,
      "Default source selection must not call the protected folder API even when available",
    );
    await searchInput(
      el,
      [first, second],
      "a/photo.jpg\nb/photo.jpg\na/photo.jpg",
    );
    assert.equal(el("copy").disabled, false);
    assert.equal(el("copy").textContent, "선택 파일 다운로드");
    assert.equal(
      el("destination").disabled,
      false,
      "Standard source selection must allow choosing a destination",
    );
    await el("copy").fire("click");
    assert.deepEqual(
      downloads.map((d) => d.name),
      ["photo.jpg", "photo_1.jpg"],
    );
    assert.equal(downloads[0].blob, first);
    assert.equal(downloads[1].blob, second);
    assert.equal(await downloads[0].blob.text(), "first");
    assert.equal(await downloads[1].blob.text(), "second");
    assert.ok(downloads.every((d) => d.node.removed));
    assert.match(el("toast").textContent, /요청 2개/);
    assert.match(el("toast").textContent, /실제 저장 여부는 브라우저/);
    assert.doesNotMatch(el("toast").textContent, /저장 완료|복사 완료/);
    assert.equal(
      el("save-hint").textContent,
      "미지정 시 각 파일을 일반 다운로드로 저장합니다. 저장 위치는 브라우저 설정을 따르며 새 폴더는 만들지 않습니다. 여러 파일 다운로드 허용이 필요할 수 있습니다.",
    );
    assert.equal(el("copy-output").hidden, true);
    assert.equal(cleanup.length, 2);
    cleanup.forEach((callback) => callback());
    assert.equal(revoked.length, 2);
    await el("reset").fire("click");
    assert.equal(el("copy-output").hidden, true);
  } finally {
    h.restore();
  }
});

test("native selection and explicit copying retain directory identity checks and preserve bytes", async () => {
  let nextDirectory,
    pickerError,
    pickerCalls = 0;
  const written = [];
  let destinationReads = 0,
    createdFiles = 0;
  const sourceFile = new Blob(["photo"]);
  const source = {
    kind: "directory",
    name: "source",
    id: "source",
    async resolve() {
      return null;
    },
    async isSameEntry(other) {
      return this.id === other.id;
    },
    async *values() {
      yield {
        kind: "file",
        name: "photo.jpg",
        getFile: async () => sourceFile,
      };
    },
  };
  const destination = {
    kind: "directory",
    name: "output",
    id: "output",
    async *values() {
      destinationReads++;
    },
    async getDirectoryHandle(name, options) {
      if (!options?.create) throw new DOMException("Missing", "NotFoundError");
      return { ...destination, name };
    },
    async getFileHandle(name, options) {
      if (!options?.create) throw new DOMException("Missing", "NotFoundError");
      assert.match(this.name, /^\d{8}_\d{6}(?:_\d+)?$/);
      createdFiles++;
      assert.equal(name, "photo.jpg");
      return {
        getFile: async () => new Blob([]),
        createWritable: async () => ({
          write: async (bytes) => written.push(bytes),
          close: async () => {},
        }),
      };
    },
  };
  const h = await setup({
    showDirectoryPicker: async () => {
      pickerCalls++;
      if (pickerError) throw pickerError;
      return nextDirectory;
    },
    showSaveFilePicker: () => assert.fail("Must not export ZIP"),
  });
  const { el, downloads } = h;
  try {
    let inputClicks = 0;
    el("folder-input").click = () => {
      inputClicks++;
    };
    pickerError = new DOMException("Blocked", "SecurityError");
    await el("source-alternative").fire("click");
    assert.match(el("toast").textContent, /기본 ‘원본 폴더 선택’/);
    assert.equal(
      inputClicks,
      0,
      "Fallback must require its own click activation",
    );
    pickerError = new DOMException("Cancelled", "AbortError");
    await el("source-alternative").fire("click");
    assert.equal(el("destination").disabled, false);
    pickerError = null;
    nextDirectory = source;
    await el("source-alternative").fire("click");
    await selectExtensions(el, "");
    el("items").value = "photo.jpg";
    await el("search").fire("click");
    const beforeDownload = pickerCalls;
    await el("copy").fire("click");
    assert.equal(
      pickerCalls,
      beforeDownload,
      "Native source must still default to ordinary download",
    );
    assert.equal(downloads.length, 1);
    assert.equal(createdFiles, 0);

    nextDirectory = destination;
    await el("destination").fire("click");
    assert.equal(el("copy").textContent, "선택 파일 복사");
    const beforeCopy = pickerCalls;
    await el("copy").fire("click");
    assert.equal(pickerCalls, beforeCopy);
    assert.equal(createdFiles, 1);
    assert.equal(await new Blob(written).text(), "photo");
    assert.equal(
      downloads.length,
      1,
      "Explicit destination must copy rather than download",
    );

    nextDirectory = source;
    await el("destination").fire("click");
    assert.match(el("toast").textContent, /원본 폴더와 저장 폴더가 같습니다/);
    assert.equal(el("dest-label").textContent, "output");
    source.isSameEntry = async () => true;
    destinationReads = 0;
    createdFiles = 0;
    await el("copy").fire("click");
    assert.equal(destinationReads, 0);
    assert.equal(createdFiles, 0);
    assert.equal(
      downloads.length,
      1,
      "Rejected direct copy must not silently download",
    );
    await el("destination-reset").fire("click");
    assert.equal(el("copy").textContent, "선택 파일 다운로드");
    await el("source").fire("click");
    assert.equal(inputClicks, 1);
    await searchInput(el, [inputFile("fallback/other.jpg")], "other.jpg");
    assert.equal(el("destination").disabled, false);
    assert.equal(el("copy").disabled, false);
  } finally {
    h.restore();
  }
});

test("browsers without directory APIs use standard source selection and ordinary downloads", async () => {
  const h = await setup();
  const { el, downloads } = h;
  try {
    let inputClicks = 0;
    el("folder-input").click = () => {
      inputClicks++;
    };
    assert.equal(el("source").disabled, false);
    assert.equal(el("source-alternative").hidden, true);
    assert.equal(el("destination").disabled, true);
    await el("source").fire("click");
    assert.equal(inputClicks, 1);
    await searchInput(el, [inputFile("source/photo.jpg")], "photo.jpg");
    assert.equal(el("source").disabled, false);
    assert.equal(el("copy").disabled, false);
    await el("copy").fire("click");
    assert.equal(downloads.length, 1);
    await el("reset").fire("click");
    assert.equal(el("source").disabled, false);
  } finally {
    h.restore();
  }
});

test("cancelling download requests stops unrequested files without claiming to cancel browser downloads", async () => {
  const h = await setup({}, (_, el) => {
    el("cancel").fire("click");
  });
  try {
    await searchInput(
      h.el,
      [inputFile("source/a.jpg"), inputFile("source/b.jpg")],
      "a.jpg\nb.jpg",
    );
    await h.el("copy").fire("click");
    assert.equal(h.downloads.length, 1);
    assert.match(
      h.el("toast").textContent,
      /다운로드 요청 취소 · 요청 1개.*미요청 1개/,
    );
    assert.equal(h.el("copy").disabled, false);
  } finally {
    h.restore();
  }
});

test("failed download requests release their URLs, report failure, and allow remaining files", async () => {
  const h = await setup({}, (node) => {
    if (node.download === "a.jpg") throw new Error("Download blocked");
  });
  try {
    await searchInput(
      h.el,
      [inputFile("source/a.jpg"), inputFile("source/b.jpg")],
      "a.jpg\nb.jpg",
    );
    await h.el("copy").fire("click");
    assert.deepEqual(
      h.downloads.map((d) => d.name),
      ["b.jpg"],
    );
    assert.match(h.el("toast").textContent, /요청 1개 \/ 요청 실패 1개/);
    assert.equal(h.revoked.length, 1);
    assert.equal(h.cleanup.length, 1);
  } finally {
    h.restore();
  }
});

test("standard input can choose a destination before and after downloading and copy into isolated result folders", async () => {
  let nextDirectory,
    pickerError,
    pickerCalls = 0,
    creations = 0;
  const outputs = [];
  const parent = {
    kind: "directory",
    name: "output",
    getFileHandle: () =>
      assert.fail("Never write into the unverified source/destination parent"),
    async getDirectoryHandle(name, options) {
      if (!options?.create) {
        if (outputs.some((output) => output.name === name))
          return { kind: "directory", name };
        throw new DOMException("Missing", "NotFoundError");
      }
      creations++;
      const bytes = [];
      const output = { name, bytes };
      outputs.push(output);
      return {
        kind: "directory",
        name,
        async *values() {},
        async getFileHandle(fileName, create) {
          if (!create?.create)
            throw new DOMException("Missing", "NotFoundError");
          assert.equal(fileName, "photo.jpg");
          return {
            getFile: async () => new Blob([]),
            createWritable: async () => ({
              write: async (chunk) => bytes.push(chunk),
              close: async () => {},
            }),
          };
        },
      };
    },
  };
  const h = await setup({
    showDirectoryPicker: async () => {
      pickerCalls++;
      if (pickerError) throw pickerError;
      return nextDirectory;
    },
  });
  try {
    assert.equal(
      h.el("destination").disabled,
      false,
      "Destination button must be clickable even before source selection",
    );
    await searchInput(
      h.el,
      [inputFile("source/photo.jpg", "unchanged bytes")],
      "photo.jpg",
    );
    await h.el("copy").fire("click");
    assert.equal(h.downloads.length, 1);
    assert.equal(
      h.el("destination").disabled,
      false,
      "Downloading must not disable subsequent destination selection",
    );
    nextDirectory = parent;
    await h.el("destination").fire("click");
    assert.equal(h.el("dest-label").textContent, "output");
    assert.equal(h.el("copy").textContent, "선택 파일 복사");
    assert.equal(
      creations,
      0,
      "Choosing a parent must not create an output folder yet",
    );
    await h.el("copy").fire("click");
    assert.equal(pickerCalls, 1);
    assert.equal(creations, 1);
    assert.equal(await new Blob(outputs[0].bytes).text(), "unchanged bytes");
    assert.match(h.el("copy-output").textContent, /output\/\d{8}_\d{6}/);
    assert.equal(
      h.downloads.length,
      1,
      "Explicit copy must not fall back to download",
    );
    await h.el("copy").fire("click");
    assert.equal(creations, 2);
    assert.notEqual(outputs[0].name, outputs[1].name);
    pickerError = new DOMException("Cancelled", "AbortError");
    await h.el("destination").fire("click");
    assert.equal(h.el("dest-label").textContent, "output");
    pickerError = new DOMException("Denied", "NotAllowedError");
    await h.el("destination").fire("click");
    assert.equal(h.el("dest-label").textContent, "output");
    assert.match(h.el("toast").textContent, /접근할 수 없습니다/);
    await h.el("destination-reset").fire("click");
    assert.equal(h.el("copy").textContent, "선택 파일 다운로드");
  } finally {
    h.restore();
  }
});

test("source counts and downloads exclude Zone.Identifier sidecars", async () => {
  const h = await setup();
  try {
    const photo = inputFile("source/photo.jpg", "original");
    await searchInput(
      h.el,
      [
        photo,
        inputFile("source/photo.jpg.Zone.Identifier", "metadata"),
        inputFile("source/Zone.Identifier", "metadata"),
      ],
      "photo.jpg\nphoto.jpg.Zone.Identifier\nZone.Identifier",
    );
    assert.match(h.el("source-detail").textContent, /^1/);
    await h.el("copy").fire("click");
    assert.deepEqual(
      h.downloads.map((file) => file.name),
      ["photo.jpg"],
    );
    assert.equal(h.downloads[0].blob, photo);
  } finally {
    h.restore();
  }
});

for (const failure of [
  "open",
  "write",
  "close",
  "cancel",
  "race",
  "abort",
  "read",
  "read-midway",
]) {
  test(`failed copy (${failure}) preserves originals and never deletes output entries`, async () => {
    const original = inputFile("source/photo.jpg", "original bytes");
    if (failure === "read" || failure === "read-midway") {
      original.stream = () => {
        let reads = 0;
        return new ReadableStream({
          pull(controller) {
            if (failure === "read-midway" && reads++ === 0)
              controller.enqueue(new Uint8Array([1, 2, 3]));
            else
              controller.error(
                new DOMException("Source disconnected", "NotReadableError"),
              );
          },
        });
      };
    }
    const existing = new Blob(["existing destination bytes"]);
    let commits = 0,
      aborts = 0,
      attempts = 0;
    let h;
    const parent = {
      kind: "directory",
      name: "output",
      removeEntry: () => assert.fail("Must never delete"),
      getFileHandle: () =>
        assert.fail("Never open files in the selected parent"),
      async getDirectoryHandle(name, options) {
        if (!options?.create)
          throw new DOMException("Missing", "NotFoundError");
        return {
          kind: "directory",
          name,
          async *values() {},
          removeEntry: () => assert.fail("Must never delete partial files"),
          async getFileHandle(name, options) {
            if (!options?.create)
              throw new DOMException("Missing", "NotFoundError");
            return {
              getFile: async () =>
                failure === "race" ? existing : new Blob([]),
              async createWritable() {
                attempts++;
                if (failure === "open")
                  throw new DOMException("Quota", "QuotaExceededError");
                return {
                  async write() {
                    if (["write", "abort"].includes(failure))
                      throw new Error("Disk write failed");
                    if (failure === "cancel")
                      await h.el("cancel").fire("click");
                  },
                  async close() {
                    if (failure === "close") throw new Error("Commit failed");
                    commits++;
                  },
                  async abort() {
                    aborts++;
                    if (failure === "abort") throw new Error("Abort failed");
                  },
                };
              },
            };
          },
        };
      },
    };
    h = await setup({ showDirectoryPicker: async () => parent });
    try {
      await searchInput(h.el, [original], "photo.jpg");
      await h.el("destination").fire("click");
      await h.el("copy").fire("click");
      assert.equal(await original.text(), "original bytes");
      assert.equal(await existing.text(), "existing destination bytes");
      assert.equal(commits, 0);
      assert.equal(
        h.downloads.length,
        0,
        "No automatic fallback after failure",
      );
      assert.equal(h.el("copy").disabled, false, "Allow retry after failure");
      assert.match(h.el("log").textContent, /자동 삭제하지 않습니다/);
      if (failure === "race") assert.equal(attempts, 0);
      if (
        ["write", "close", "cancel", "abort", "read", "read-midway"].includes(
          failure,
        )
      )
        assert.equal(aborts, 1);
    } finally {
      h.restore();
    }
  });
}

test("imported JPG reference names find checked RAW formats and exclude unchecked video", async () => {
  const h = await setup();
  try {
    const raw = inputFile("source/photo.CR3", "RAW original");
    h.el("folder-input").files = [raw, inputFile("source/photo.MP4", "video")];
    await h.el("folder-input").fire("change");
    h.el("reference-input").files = [
      inputFile("reference/photo.JPG"),
      inputFile("reference/photo.JPG.Zone.Identifier"),
    ];
    await h.el("reference-input").fire("change");
    assert.equal(h.el("items").value, '\"photo.JPG\"');
    await selectExtensions(h.el, ".cr3");
    await h.el("search").fire("click");
    await h.el("copy").fire("click");
    assert.deepEqual(
      h.downloads.map((d) => d.name),
      ["photo.CR3"],
    );
    assert.equal(h.downloads[0].blob, raw);
  } finally {
    h.restore();
  }
});
test("JPG inputs find selected RAW files without a separate option", async () => {
  const h = await setup();
  try {
    const raw = inputFile("source/photo.CR3", "RAW bytes");
    await searchInput(
      h.el,
      [raw, inputFile("source/photo.MP4", "video")],
      "photo.JPG",
      ".cr3",
    );
    assert.equal(h.el("copy").disabled, false);
    await h.el("copy").fire("click");
    assert.deepEqual(
      h.downloads.map((file) => file.name),
      ["photo.CR3"],
    );
    assert.equal(h.downloads[0].blob, raw);
  } finally {
    h.restore();
  }
});

for (const scenario of [
  "1000 files",
  "partial failure",
  "cancel after success",
]) {
  test(`copy analytics reports one operation with actual file counts: ${scenario}`, async () => {
    let h,
      commits = 0;
    const win = { location: { origin: "https://lucky2449.github.io" } };
    const parent = {
      kind: "directory",
      name: "output",
      getFileHandle: () => assert.fail("Never write into the parent"),
      async getDirectoryHandle(name, options) {
        if (!options?.create)
          throw new DOMException("Missing", "NotFoundError");
        return {
          kind: "directory",
          name,
          async *values() {},
          async getFileHandle(fileName, options) {
            if (!options?.create)
              throw new DOMException("Missing", "NotFoundError");
            return {
              getFile: async () => new Blob([]),
              async createWritable() {
                return {
                  async write() {
                    if (
                      scenario === "partial failure" &&
                      fileName === "PRIVATE_1.jpg"
                    )
                      throw new Error("PRIVATE disk failure");
                  },
                  async close() {
                    commits++;
                    if (scenario === "cancel after success")
                      await h.el("cancel").fire("click");
                  },
                  async abort() {},
                };
              },
            };
          },
        };
      },
    };
    win.showDirectoryPicker = async () => parent;
    h = await setup(win);
    try {
      const count = scenario === "1000 files" ? 1000 : 3;
      const source = Array.from({ length: count }, (_, i) =>
        inputFile(`source/PRIVATE_${i}.jpg`, "original"),
      );
      await searchInput(
        h.el,
        source,
        source.map((file) => file.name).join("\n"),
      );
      await h.el("destination").fire("click");
      await h.el("copy").fire("click");
      const events = win.dataLayer
        .map((args) => Array.from(args))
        .filter(([command]) => command === "event");
      const success = events.filter(([, name]) => name === "copy_success");
      const failed = events.filter(([, name]) => name === "copy_failure");
      assert.equal(success.length, 1);
      assert.equal(success[0][2].copied_file_count, commits);
      assert.equal(
        commits,
        scenario === "1000 files"
          ? 1000
          : scenario === "partial failure"
            ? 2
            : 1,
      );
      assert.equal(failed.length, scenario === "partial failure" ? 1 : 0);
      if (failed.length) assert.equal(failed[0][2].failed_file_count, 1);
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE|original/);
      assert.equal(await source[0].text(), "original");
    } finally {
      h.restore();
    }
  });
}

test("an inferred single candidate cannot be downloaded until explicitly confirmed", async () => {
  const h = await setup();
  try {
    const original = inputFile("source/P1000001.RW2", "original RAW bytes");
    await searchInput(h.el, [original], "1");
    assert.equal(h.el("stat-found").textContent, 0);
    assert.equal(h.el("stat-attention").textContent, 1);
    assert.equal(h.el("copy").disabled, true);
    assert.equal(h.el("zip").disabled, true);
    await h.el("copy").fire("click");
    assert.equal(h.downloads.length, 0);
    const findSelect = (node) => {
      if (
        node.handlers?.has("change") &&
        node.children?.some((child) => child.text?.includes("후보"))
      )
        return node;
      for (const child of node.children ?? []) {
        const found = findSelect(child);
        if (found) return found;
      }
    };
    const select = findSelect(h.el("rows"));
    assert.ok(select, "Single inferred candidate needs a confirmation control");
    select.value = "0";
    await select.fire("change");
    assert.equal(h.el("copy").disabled, false);
    await h.el("copy").fire("click");
    assert.equal(h.downloads.length, 1);
    assert.equal(h.downloads[0].blob, original);
    assert.equal(await original.text(), "original RAW bytes");
    h.el("camera-numbers").checked = false;
    await h.el("camera-numbers").fire("change");
    await h.el("search").fire("click");
    assert.equal(h.el("copy").disabled, true);
    await h.el("reset").fire("click");
    assert.equal(h.el("camera-numbers").checked, true);
  } finally {
    h.restore();
  }
});

test("checked and all extensions preview companions and download each source once", async () => {
  const h = await setup();
  const { el, downloads } = h;
  try {
    const jpg = inputFile("source/a/IMG_0001.JPG", "jpeg-original");
    const raw = inputFile("source/a/IMG_0001.CR3", "raw-original");
    const other = inputFile("source/b/IMG_0001.CR3", "other-folder");
    await searchInput(el, [jpg, raw, other], "a/IMG_0001.JPG", [
      ".jpg",
      ".cr3",
    ]);
    assert.equal(el("selected-count").textContent, "선택한 파일 2개");
    const content = el("rows").children[0].children[0].children[1];
    assert.ok(
      content.children.some(
        (node) => node.textContent === "함께 저장: source/a/IMG_0001.CR3",
      ),
    );
    await el("copy").fire("click");
    assert.deepEqual(
      downloads.map((d) => d.name),
      ["IMG_0001.JPG", "IMG_0001.CR3"],
    );
    assert.equal(downloads[0].blob, jpg);
    assert.equal(downloads[1].blob, raw);
    assert.equal(await raw.text(), "raw-original");
    await selectExtensions(el, "");
    assert.equal(el("copy").disabled, true);
    await el("search").fire("click");
    assert.equal(el("selected-count").textContent, "선택한 파일 2개");
  } finally {
    h.restore();
  }
});

for (const mode of ["copy", "zip"]) {
  test(`RAW + JPG ${mode} writes both original contents through the existing safe output path`, async () => {
    const outputs = new Map();
    const missing = () => {
      throw new DOMException("Missing", "NotFoundError");
    };
    const destination = {
      kind: "directory",
      name: "output",
      async getDirectoryHandle(name, options) {
        if (!options?.create) return missing();
        return {
          kind: "directory",
          name,
          async *values() {},
          async getFileHandle(name, options) {
            if (!options?.create) return missing();
            return {
              getFile: async () => new Blob([]),
              async createWritable(options) {
                assert.equal(options.mode, "exclusive");
                const chunks = [];
                return {
                  write: async (chunk) => chunks.push(chunk),
                  close: async () => outputs.set(name, new Blob(chunks)),
                  abort: async () => {},
                };
              },
            };
          },
        };
      },
    };
    const h = await setup({ showDirectoryPicker: async () => destination });
    try {
      const jpg = inputFile("source/IMG_0001.JPG", "jpeg-pair-original");
      const raw = inputFile("source/IMG_0001.CR3", "raw-pair-original");
      await searchInput(h.el, [jpg, raw], "1", [".jpg", ".cr3"]);
      assert.equal(h.el("selected-count").textContent, "선택한 파일 2개");
      if (mode === "copy") {
        await h.el("destination").fire("click");
        await h.el("copy").fire("click");
        assert.deepEqual([...outputs.keys()], [jpg.name, raw.name]);
        assert.equal(await outputs.get(jpg.name).text(), await jpg.text());
        assert.equal(await outputs.get(raw.name).text(), await raw.text());
        assert.match(h.el("toast").textContent, /성공 2개/);
      } else {
        await h.el("zip").fire("click");
        assert.equal(h.downloads.length, 0);
        assert.ok(outputs.has("파일모아.zip"));
        const bytes = await outputs.get("파일모아.zip").text();
        assert.ok(bytes.includes(jpg.name));
        assert.ok(bytes.includes(raw.name));
        assert.ok(bytes.includes(await jpg.text()));
        assert.ok(bytes.includes(await raw.text()));
      }
      assert.equal(await jpg.text(), "jpeg-pair-original");
      assert.equal(await raw.text(), "raw-pair-original");
    } finally {
      h.restore();
    }
  });
}

test("extension checkboxes only save checked formats, clear stale selections and reset", async () => {
  const h = await setup();
  try {
    const { el, downloads } = h;
    await searchInput(
      el,
      [
        inputFile("source/IMG_0001.JPG"),
        inputFile("source/IMG_0001.CR3"),
        inputFile("source/IMG_0001.NEF"),
        inputFile("source/IMG_0001.MP4"),
      ],
      "1",
      [".jpg", ".cr3"],
    );
    assert.equal(el("extension-all").checked, false);
    assert.equal(el("extension-summary").textContent, ".cr3, .jpg");
    assert.equal(el("selected-count").textContent, "선택한 파일 2개");
    await el("copy").fire("click");
    assert.deepEqual(
      downloads.map((d) => d.name),
      ["IMG_0001.JPG", "IMG_0001.CR3"],
    );
    await selectExtensions(el, [".cr3", ".nef"]);
    assert.equal(el("copy").disabled, true);
    await el("search").fire("click");
    assert.equal(el("selected-count").textContent, "선택한 파일 2개");
    await selectExtensions(el, ".cr3");
    await el("search").fire("click");
    assert.equal(el("selected-count").textContent, "선택한 파일 1개");
    el("extension-all").checked = false;
    await el("extension-all").fire("change");
    await el("search").fire("click");
    assert.equal(el("copy").disabled, true);
    assert.match(el("toast").textContent, /하나 이상 체크/);
    await el("reset").fire("click");
    assert.equal(el("extension-all").checked, false);
    assert.equal(el("extension-options").children.length, 0);
    assert.equal(el("extension-summary").textContent, "확장자 선택");
    let sourceClicks = 0;
    el("folder-input").click = () => sourceClicks++;
    await el("source").fire("click");
    assert.equal(sourceClicks, 1);
  } finally {
    h.restore();
  }
});

test("all formats starts unchecked on load, new source and reset; explicit selection is required", async () => {
  const h = await setup();
  try {
    const { el } = h;
    assert.equal(el("extension-all").checked, false);
    assert.equal(el("extension-summary").textContent, "확장자 선택");
    await searchInput(el, [inputFile("source/photo.jpg")], "photo.jpg", null);
    assert.equal(el("extension-all").checked, false);
    assert.equal(el("copy").disabled, true);
    assert.match(el("toast").textContent, /하나 이상 체크/);
    await selectExtensions(el, "");
    await el("search").fire("click");
    assert.equal(el("copy").disabled, false);
    await searchInput(el, [inputFile("other/photo.jpg")], "photo.jpg", null);
    assert.equal(el("extension-all").checked, false);
    assert.equal(el("copy").disabled, true);
    await el("reset").fire("click");
    assert.equal(el("extension-all").checked, false);
  } finally {
    h.restore();
  }
});

test("all formats checkbox synchronizes individual checks and partial selection without losing remaining formats", async () => {
  const h = await setup();
  try {
    const { el, downloads } = h;
    const inputs = () =>
      el("extension-options").children.map((label) => label.children[0]);
    await searchInput(
      el,
      [
        inputFile("source/photo.JPG", "jpg"),
        inputFile("source/photo.CR3", "cr3"),
        inputFile("source/photo.NEF", "nef"),
      ],
      "photo.JPG",
      null,
    );
    assert.ok(inputs().every((input) => !input.checked));
    await selectExtensions(el, "");
    assert.equal(el("extension-all").checked, true);
    assert.equal(el("extension-all").indeterminate, false);
    assert.ok(inputs().every((input) => input.checked));
    const nef = inputs().find((input) => input.value === ".nef");
    nef.checked = false;
    await nef.fire("change");
    assert.equal(el("extension-all").checked, false);
    assert.equal(el("extension-all").indeterminate, true);
    assert.deepEqual(
      inputs()
        .filter((input) => input.checked)
        .map((input) => input.value),
      [".cr3", ".jpg"],
    );
    assert.equal(el("extension-summary").textContent, ".cr3, .jpg");
    assert.equal(el("copy").disabled, true);
    await el("search").fire("click");
    await el("copy").fire("click");
    assert.deepEqual(
      downloads.map((download) => download.name),
      ["photo.JPG", "photo.CR3"],
    );
    nef.checked = true;
    await nef.fire("change");
    assert.equal(el("extension-all").checked, true);
    assert.equal(el("extension-all").indeterminate, false);
    assert.equal(el("extension-summary").textContent, "모든 파일");
    el("extension-all").checked = false;
    await el("extension-all").fire("change");
    assert.ok(inputs().every((input) => !input.checked));
    assert.equal(el("extension-all").indeterminate, false);
    assert.equal(el("extension-summary").textContent, "확장자 선택");
    await selectExtensions(el, ".cr3");
    assert.equal(el("extension-all").indeterminate, true);
    el("extension-all").checked = true;
    await el("extension-all").fire("change");
    assert.ok(inputs().every((input) => input.checked));
    await el("reset").fire("click");
    assert.equal(el("extension-all").checked, false);
    assert.equal(el("extension-all").indeterminate, false);
  } finally {
    h.restore();
  }
});

for (const query of ["a/IMG_0001.JPG", "1"]) {
  test(`all extensions ZIP includes same-folder JPG and RAW originals once: ${query}`, async () => {
    const h = await setup();
    try {
      const { el, downloads } = h;
      const photos = [
        inputFile("source/a/IMG_0001.JPG", "jpeg-original"),
        inputFile("source/a/IMG_0001.CR3", "canon-original"),
        inputFile("source/a/IMG_0001.NEF", "nikon-original"),
      ];
      const extras = [
        inputFile("source/a/IMG_0002.CR3", "different-photo"),
        inputFile("source/a/IMG_0001.JPG.Zone.Identifier", "sidecar"),
      ];
      if (query.includes("/"))
        extras.push(inputFile("source/b/IMG_0001.CR3", "other-folder"));
      await searchInput(el, [...photos, ...extras], query, "");
      await el("zip").fire("click");
      assert.equal(downloads.length, 1);
      const bytes = new Uint8Array(await downloads[0].blob.arrayBuffer());
      const view = new DataView(bytes.buffer);
      const end = bytes.length - 22;
      assert.equal(view.getUint32(end, true), 0x06054b50);
      assert.equal(view.getUint16(end + 10, true), photos.length);
      let offset = view.getUint32(end + 16, true);
      const entries = new Map();
      for (let i = 0; i < photos.length; i++) {
        assert.equal(view.getUint32(offset, true), 0x02014b50);
        const length = view.getUint16(offset + 28, true);
        const name = new TextDecoder().decode(
          bytes.subarray(offset + 46, offset + 46 + length),
        );
        const size = view.getUint32(offset + 24, true);
        const local = view.getUint32(offset + 42, true);
        const start =
          local +
          30 +
          view.getUint16(local + 26, true) +
          view.getUint16(local + 28, true);
        entries.set(
          name,
          new TextDecoder().decode(bytes.subarray(start, start + size)),
        );
        offset +=
          46 +
          length +
          view.getUint16(offset + 30, true) +
          view.getUint16(offset + 32, true);
      }
      for (const photo of photos)
        assert.equal(entries.get(photo.name), await photo.text());
      assert.equal(el("selected-count").textContent, "선택한 파일 3개");
      await selectExtensions(el, [".jpg", ".cr3", ".nef"]);
      await el("search").fire("click");
      assert.equal(el("selected-count").textContent, "선택한 파일 3개");
    } finally {
      h.restore();
    }
  });
}

test("missing folder requests cannot download a namesake and RAW path lookup keeps the requested folder", async () => {
  const h = await setup();
  try {
    const { el, downloads } = h;
    const jpgB = inputFile("source/B/photo.JPG", "B-jpg");
    const rawB = inputFile("source/B/photo.CR3", "B-raw");
    await searchInput(el, [jpgB, rawB], "A/photo.JPG", "");
    assert.equal(el("copy").disabled, true);
    assert.equal(el("zip").disabled, true);
    await el("copy").fire("click");
    await el("zip").fire("click");
    assert.equal(downloads.length, 0);
    await selectExtensions(el, ".cr3");
    await el("search").fire("click");
    assert.equal(el("copy").disabled, true);
    assert.equal(el("zip").disabled, true);
    el("items").value = "photo.JPG";
    await el("search").fire("click");
    await el("copy").fire("click");
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].blob, rawB);
    const rawA = inputFile("source/A/photo.CR3", "A-raw");
    await searchInput(el, [jpgB, rawB, rawA], "A/photo.JPG", ".cr3");
    assert.equal(el("selected-count").textContent, "선택한 파일 1개");
    await el("copy").fire("click");
    assert.equal(downloads.length, 2);
    assert.equal(downloads[1].blob, rawA);
    assert.equal(await rawA.text(), "A-raw");
    assert.equal(await rawB.text(), "B-raw");
  } finally {
    h.restore();
  }
});

test("all selection routes find identical RAW outputs from JPG inputs with no JPG present", async () => {
  const h = await setup();
  try {
    const { el, downloads } = h;
    const files = [
      inputFile("source/A/IMG_0001.CR3", "A-canon"),
      inputFile("source/A/IMG_0001.NEF", "A-nikon"),
      inputFile("source/B/IMG_0001.CR3", "B-canon"),
    ];
    const outcomes = [];
    for (const selection of ["", [".cr3", ".nef"]]) {
      await searchInput(el, files, "A/IMG_0001.JPG", selection);
      assert.equal(el("extension-all").checked, true);
      assert.equal(el("extension-summary").textContent, "모든 파일");
      const before = downloads.length;
      outcomes.push({
        selected: el("selected-count").textContent,
        disabled: el("copy").disabled,
      });
      await el("copy").fire("click");
      assert.deepEqual(
        downloads.slice(before).map((d) => d.blob),
        files.slice(0, 2),
      );
      await el("zip").fire("click");
      const zip = downloads.at(-1).blob;
      const view = new DataView(await zip.arrayBuffer());
      assert.equal(view.getUint16(zip.size - 22 + 10, true), 2);
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.equal(outcomes[0].disabled, false);
  } finally {
    h.restore();
  }
});

test("hide same-photo format choice but retain cross-folder and inferred confirmation controls", async () => {
  const h = await setup();
  try {
    const { el, downloads } = h;
    const selectors = (node) => [
      ...(node.className === "row-select" ? [node] : []),
      ...(node.children ?? []).flatMap(selectors),
    ];
    const jpg = inputFile("source/A/IMG_0001.JPG", "A-jpeg");
    const raw = inputFile("source/A/IMG_0001.CR3", "A-raw");
    await searchInput(el, [jpg, raw], "IMG_0001.JPG");
    assert.equal(selectors(el("rows")).length, 0);
    assert.equal(el("selected-count").textContent, "선택한 파일 2개");
    await el("copy").fire("click");
    assert.deepEqual(
      downloads.map((d) => d.blob),
      [jpg, raw],
    );
    const jpgB = inputFile("source/B/IMG_0001.JPG", "B-jpeg");
    await searchInput(el, [jpg, raw, jpgB], "IMG_0001.JPG");
    assert.equal(el("copy").disabled, true);
    const choices = selectors(el("rows"));
    assert.equal(choices.length, 1);
    choices[0].value = "2";
    await choices[0].fire("change");
    assert.equal(selectors(el("rows")).length, 1);
    await el("copy").fire("click");
    assert.equal(downloads.at(-1).blob, jpgB);
    await searchInput(
      el,
      [inputFile("source/P1000001.JPG"), inputFile("source/P1000001.RW2")],
      "1",
    );
    assert.equal(selectors(el("rows")).length, 1);
    assert.equal(el("copy").disabled, true);
    assert.equal(el("zip").disabled, true);
  } finally {
    h.restore();
  }
});

for (const scenario of ["cancel-waiting", "unsupported"]) {
  test(`folder copy ${scenario} makes no output folder and keeps ordinary downloads usable`, async () => {
    let requested = 0,
      created = 0,
      signal;
    const locks =
      scenario === "unsupported"
        ? null
        : {
            request(name, options) {
              requested++;
              signal = options.signal;
              return new Promise((resolve, reject) =>
                options.signal.addEventListener(
                  "abort",
                  () => reject(new DOMException("Cancelled", "AbortError")),
                  { once: true },
                ),
              );
            },
          };
    const h = await setup({
      navigator: { locks },
      showDirectoryPicker: async () => ({
        kind: "directory",
        name: "output",
        async getDirectoryHandle() {
          created++;
          assert.fail("Must not create folders without lock");
        },
      }),
    });
    try {
      await searchInput(
        h.el,
        [inputFile("source/photo.jpg", "original")],
        "photo.jpg",
      );
      await h.el("destination").fire("click");
      const pending = h.el("copy").fire("click");
      if (scenario === "cancel-waiting") {
        assert.equal(requested, 1);
        assert.equal(h.el("source").disabled, true);
        assert.match(h.el("progress-label").textContent, /대기/);
        await h.el("cancel").fire("click");
        assert.equal(signal.aborted, true);
      }
      await pending;
      assert.equal(created, 0);
      assert.equal(h.el("source").disabled, false);
      if (scenario === "unsupported")
        assert.match(h.el("toast").textContent, /잠금/);
      await h.el("destination-reset").fire("click");
      await h.el("copy").fire("click");
      assert.equal(h.downloads.length, 1);
      assert.equal(await h.downloads[0].blob.text(), "original");
    } finally {
      h.restore();
    }
  });
}

test("ZIP never requests a writable file handle even when a save picker exists", async () => {
  const h = await setup({
    showSaveFilePicker: () =>
      assert.fail("ZIP must not acquire any writable file handle"),
  });
  try {
    const original = inputFile("source/photo.CR3", "RAW bytes unchanged");
    await searchInput(h.el, [original], "photo.CR3");
    await h.el("zip").fire("click");
    assert.equal(h.downloads.length, 1);
    assert.equal(h.downloads[0].name, "파일모아.zip");
    assert.equal(await original.text(), "RAW bytes unchanged");
    assert.match(h.el("toast").textContent, /다운로드를 요청/);
    assert.doesNotMatch(h.el("toast").textContent, /저장했습니다|저장 완료/);
  } finally {
    h.restore();
  }
});

for (const scenario of ["cancel-picker", "denied-picker", "oversize"]) {
  test(`disk ZIP ${scenario} creates no download and restores controls`, async () => {
    let picked = 0;
    const h = await setup({
      showSaveFilePicker: () => assert.fail("Never select an existing file"),
      showDirectoryPicker: async (options) => {
        picked++;
        assert.equal(options.mode, "readwrite");
        throw new DOMException(
          "Picker stopped",
          scenario === "cancel-picker" ? "AbortError" : "NotAllowedError",
        );
      },
    });
    try {
      const original = inputFile("source/photo.CR3", "original");
      if (scenario === "oversize")
        Object.defineProperty(original, "size", {
          value: 4 * 1024 * 1024 * 1024,
        });
      await searchInput(h.el, [original], "photo.CR3");
      await h.el("zip").fire("click");
      assert.equal(picked, scenario === "oversize" ? 0 : 1);
      assert.equal(h.downloads.length, 0);
      assert.equal(h.el("zip").disabled, false);
      assert.equal(await original.text(), "original");
      if (scenario === "oversize")
        assert.match(h.el("toast").textContent, /4GB/);
    } finally {
      h.restore();
    }
  });
}
