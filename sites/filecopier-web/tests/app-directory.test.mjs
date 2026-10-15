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
async function searchInput(el, files, items) {
  el("folder-input").files = files;
  await el("folder-input").fire("change");
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
    async getFileHandle(name, options) {
      if (!options?.create) throw new DOMException("Missing", "NotFoundError");
      createdFiles++;
      assert.equal(name, "photo.jpg");
      return {
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
      if (!options?.create) throw new DOMException("Missing", "NotFoundError");
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
    assert.match(h.el("copy-output").textContent, /output\/파일모아_/);
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
    await searchInput(h.el, [photo,
      inputFile("source/photo.jpg.Zone.Identifier", "metadata"),
      inputFile("source/Zone.Identifier", "metadata"),
    ], "photo.jpg\nphoto.jpg.Zone.Identifier\nZone.Identifier");
    assert.match(h.el("source-detail").textContent, /^1/);
    await h.el("copy").fire("click");
    assert.deepEqual(h.downloads.map((file) => file.name), ["photo.jpg"]);
    assert.equal(h.downloads[0].blob, photo);
  } finally {
    h.restore();
  }
});
