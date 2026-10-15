import assert from "node:assert/strict";
import test from "node:test";

// Exercise the real app event handlers without granting access to local folders.
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
  click() {
    return this.fire("click");
  }
}

test("app blocks identical folders at selection and rechecks before any destination access", async () => {
  const previous = Object.fromEntries(
    ["document", "window", "Option", "setTimeout", "clearTimeout"].map(
      (key) => [key, globalThis[key]],
    ),
  );
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let nextDirectory;
  let pickerError;
  let pickerCalls = 0;
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
  try {
    globalThis.document = {
      getElementById: element,
      createElement: () => new Element(),
      createDocumentFragment: () => new Element(),
      body: new Element(),
    };
    globalThis.window = {
      showDirectoryPicker: async () => {
        pickerCalls++;
        if (pickerError) throw pickerError;
        return nextDirectory;
      },
      showSaveFilePicker: () =>
        assert.fail("Copy must never open a ZIP picker"),
    };
    globalThis.Option = class {
      constructor(text, value) {
        this.text = text;
        this.value = value;
      }
    };
    globalThis.setTimeout = (callback, ms) => {
      if (ms === 0) queueMicrotask(callback);
      return 1;
    };
    globalThis.clearTimeout = () => {};
    await import("../dist/app.mjs");
    assert.equal(element("destination").disabled, true);
    let fallbackClicks = 0;
    element("folder-input").click = () => {
      fallbackClicks++;
    };
    pickerError = new DOMException("Blocked", "SecurityError");
    await element("source").fire("click");
    assert.match(element("toast").textContent, /폴더 접근이 차단/);
    assert.equal(
      fallbackClicks,
      0,
      "Blocked native picker must not silently switch to ZIP input",
    );
    pickerError = new DOMException("Cancelled", "AbortError");
    await element("source").fire("click");
    assert.equal(element("destination").disabled, true);
    pickerError = null;
    nextDirectory = source;
    await element("source").fire("click");
    assert.equal(
      pickerCalls,
      3,
      "Primary source button must invoke the native picker",
    );
    assert.equal(element("source-name").textContent, "source");
    assert.equal(element("destination").disabled, false);
    element("items").value = "photo.jpg";
    await element("search").fire("click");
    assert.equal(
      element("copy").disabled,
      true,
      "Destination is required for copying",
    );
    assert.equal(element("copy").textContent, "선택 파일 복사");
    assert.equal(
      element("zip").disabled,
      false,
      "ZIP remains an explicit alternative",
    );
    await element("copy").fire("click");
    assert.match(element("toast").textContent, /저장 폴더를 먼저 선택/);
    assert.equal(destinationReads, 0);

    nextDirectory = destination;
    await element("destination").fire("click");
    assert.equal(element("dest-label").textContent, "output");
    assert.equal(element("copy").disabled, false);
    await element("copy").fire("click");
    assert.equal(createdFiles, 1);
    assert.equal(
      await new Blob(written).text(),
      "photo",
      "Direct copy must preserve file bytes",
    );
    assert.match(element("toast").textContent, /복사 완료 · 성공 1개/);
    destinationReads = 0;
    createdFiles = 0;
    nextDirectory = source;
    await element("destination").fire("click");
    assert.match(
      element("toast").textContent,
      /원본 폴더와 저장 폴더가 같습니다/,
    );
    assert.equal(
      element("dest-label").textContent,
      "output",
      "Rejected selection must preserve the previous safe destination",
    );

    source.isSameEntry = async () => true;
    await element("copy").fire("click");
    assert.equal(
      destinationReads,
      0,
      "Identity must be checked before destination enumeration",
    );
    assert.equal(
      createdFiles,
      0,
      "Identity must be checked before creating or opening files",
    );
    assert.match(
      element("toast").textContent,
      /원본 폴더와 저장 폴더가 같습니다/,
    );

    await element("source-alternative").fire("click");
    assert.equal(
      fallbackClicks,
      1,
      "ZIP input opens only on explicit fallback click",
    );
    element("folder-input").files = [
      { name: "other.jpg", webkitRelativePath: "fallback/other.jpg" },
    ];
    await element("folder-input").fire("change");
    assert.equal(
      element("destination").disabled,
      true,
      "Standard input must clear the previous source handle",
    );
    assert.equal(element("copy").textContent, "선택 파일 복사");
    element("items").value = "other.jpg";
    await element("search").fire("click");
    assert.equal(element("copy").disabled, true);
    assert.equal(element("zip").disabled, false);
    assert.match(
      element("save-hint").textContent,
      /파일 선택창으로 읽은 원본은 ZIP/,
    );
    await element("reset").fire("click");
    assert.equal(element("destination").disabled, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test("unsupported browsers keep direct copy disabled and require explicit ZIP fallback", async () => {
  const keys = ["document", "window", "Option", "setTimeout", "clearTimeout"];
  const previous = Object.fromEntries(
    keys.map((key) => [key, globalThis[key]]),
  );
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let fallbackClicks = 0;
  try {
    globalThis.document = {
      getElementById: element,
      createElement: () => new Element(),
      createDocumentFragment: () => new Element(),
      body: new Element(),
    };
    globalThis.window = {};
    globalThis.Option = class {};
    globalThis.setTimeout = (callback, ms) => {
      if (ms === 0) queueMicrotask(callback);
      return 1;
    };
    globalThis.clearTimeout = () => {};
    element("folder-input").click = () => {
      fallbackClicks++;
    };
    await import("../dist/app.mjs?unsupported");
    assert.equal(element("source").disabled, true);
    assert.equal(element("destination").disabled, true);
    assert.match(element("save-hint").textContent, /직접 복사를 지원하지 않는/);
    assert.equal(fallbackClicks, 0);
    await element("source-alternative").fire("click");
    assert.equal(fallbackClicks, 1);
    element("folder-input").files = [
      { name: "photo.jpg", webkitRelativePath: "source/photo.jpg" },
    ];
    await element("folder-input").fire("change");
    element("items").value = "photo.jpg";
    await element("search").fire("click");
    assert.equal(
      element("source").disabled,
      true,
      "Busy reset must preserve unsupported state",
    );
    assert.equal(element("copy").disabled, true);
    assert.equal(element("copy").textContent, "선택 파일 복사");
    assert.equal(element("zip").disabled, false);
    await element("reset").fire("click");
    assert.equal(element("source").disabled, true);
    assert.match(element("source-detail").textContent, /Chrome·Edge/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
