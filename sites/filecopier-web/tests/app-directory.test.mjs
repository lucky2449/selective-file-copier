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
    async getFileHandle() {
      createdFiles++;
      throw new Error("No destination file should be opened");
    },
  };
  try {
    globalThis.document = {
      getElementById: element,
      createElement: () => new Element(),
      createDocumentFragment: () => new Element(),
      body: new Element(),
    };
    globalThis.window = { showDirectoryPicker: async () => nextDirectory };
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
    nextDirectory = source;
    await element("source-native").fire("click");
    assert.equal(element("source-name").textContent, "source");
    assert.equal(element("destination").disabled, false);
    element("items").value = "photo.jpg";
    await element("search").fire("click");
    assert.equal(element("copy").disabled, false);

    nextDirectory = destination;
    await element("destination").fire("click");
    assert.equal(element("dest-label").textContent, "output");
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

    element("folder-input").files = [
      { name: "other.jpg", webkitRelativePath: "fallback/other.jpg" },
    ];
    await element("folder-input").fire("change");
    assert.equal(
      element("destination").disabled,
      true,
      "Standard input must clear the previous source handle",
    );
    assert.equal(element("copy").textContent, "선택 파일 ZIP 저장");
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
