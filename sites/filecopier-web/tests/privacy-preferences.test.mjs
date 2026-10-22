import test from "node:test";
import assert from "node:assert/strict";
import {
  createPrivacyPreferences,
  parsePrivacyPreferences,
  PRIVACY_STORAGE_KEY,
} from "../dist/privacy-preferences.mjs";

class Node {
  checked = false;
  open = false;
  textContent = "";
  attributes = {};
  handlers = new Map();
  focusCount = 0;
  addEventListener(name, fn) {
    this.handlers.set(name, fn);
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  focus() {
    this.focusCount++;
  }
  fire(name, event = {}) {
    this.handlers.get(name)?.(event);
  }
}
function fixture(initial = null, storageMode = "normal") {
  let saved = initial;
  const changes = [],
    elements = new Map(),
    handlers = new Map(),
    focus = new Node();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new Node());
    return elements.get(id);
  };
  const storage = {
    getItem() {
      if (storageMode === "blocked-read") throw new Error("blocked");
      return saved;
    },
    setItem(key, value) {
      assert.equal(key, PRIVACY_STORAGE_KEY);
      if (storageMode === "blocked-write") throw new Error("quota");
      saved = value;
    },
  };
  const window = {
    localStorage: storage,
    addEventListener: (name, fn) => handlers.set(name, fn),
  };
  const document = { getElementById: el, activeElement: focus };
  const controller = createPrivacyPreferences({
    window,
    document,
    onChange: (value) => changes.push(value),
    now: () => new Date("2026-10-22T03:00:00Z"),
  });
  return {
    controller,
    el,
    changes,
    handlers,
    storage,
    focus,
    saved: () => saved,
  };
}
function record(analytics = false, operationLogs = false) {
  return JSON.stringify({
    schemaVersion: 1,
    noticeVersion: "previous-notice",
    updatedAt: "2020-01-01T00:00:00Z",
    analytics,
    operationLogs,
  });
}

test("first visit opens centrally with both options off and no permission granted", () => {
  const h = fixture();
  assert.equal(h.el("privacy-dialog").open, true);
  assert.equal(h.el("privacy-analytics").checked, false);
  assert.equal(h.el("privacy-operation-logs").checked, false);
  assert.deepEqual(h.changes, [{ analytics: false, operationLogs: false }]);
  assert.equal(h.saved(), null);
});
test("individual consent persists only whitelisted preference fields and suppresses repeat popup", () => {
  const h = fixture();
  h.el("privacy-analytics").checked = true;
  h.el("privacy-allow").fire("click");
  assert.equal(h.el("privacy-dialog").open, false);
  assert.deepEqual(h.changes.at(-1), { analytics: true, operationLogs: false });
  assert.deepEqual(Object.keys(JSON.parse(h.saved())).sort(), [
    "analytics",
    "noticeVersion",
    "operationLogs",
    "schemaVersion",
    "updatedAt",
  ]);
  const revisit = fixture(h.saved());
  assert.equal(revisit.el("privacy-dialog").open, false);
  assert.deepEqual(revisit.changes.at(-1), {
    analytics: true,
    operationLogs: false,
  });
});
test("explicit refusal is remembered just like acceptance", () => {
  const h = fixture();
  h.el("privacy-analytics").checked = h.el("privacy-operation-logs").checked =
    true;
  h.el("privacy-reject").fire("click");
  const revisit = fixture(h.saved());
  assert.equal(revisit.el("privacy-dialog").open, false);
  assert.deepEqual(revisit.changes.at(-1), {
    analytics: false,
    operationLogs: false,
  });
});
test("first close and Escape remember refusal, never unchecked implied consent", () => {
  for (const via of ["close", "escape"]) {
    const h = fixture();
    h.el("privacy-analytics").checked = true;
    if (via === "close") h.el("privacy-close").fire("click");
    else {
      let prevented = false;
      h.el("privacy-dialog").fire("cancel", {
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(prevented, true);
    }
    assert.deepEqual(h.changes.at(-1), {
      analytics: false,
      operationLogs: false,
    });
    assert.equal(fixture(h.saved()).el("privacy-dialog").open, false);
  }
});
test("settings can reopen; dismiss cancels edits; explicit refusal withdraws permission", () => {
  const h = fixture(record(true, true));
  h.el("privacy-settings").fire("click");
  assert.equal(h.el("privacy-dialog").open, true);
  assert.equal(h.el("privacy-analytics").checked, true);
  h.el("privacy-analytics").checked = false;
  h.el("privacy-close").fire("click");
  assert.deepEqual(h.changes.at(-1), { analytics: true, operationLogs: true });
  h.el("privacy-settings").fire("click");
  assert.equal(h.el("privacy-analytics").checked, true);
  h.el("privacy-reject").fire("click");
  assert.deepEqual(h.changes.at(-1), {
    analytics: false,
    operationLogs: false,
  });
  assert.ok(h.focus.focusCount >= 2);
});
test("stored choice remains valid across notice versions and passage of time", () => {
  const h = fixture(record(false, true));
  assert.equal(h.el("privacy-dialog").open, false);
  assert.deepEqual(h.changes.at(-1), { analytics: false, operationLogs: true });
});
test("invalid storage fails closed without preventing file UI initialization", () => {
  for (const value of [
    null,
    "broken",
    "{}",
    '{"schemaVersion":1}',
    record().replace('"analytics":false', '"analytics":"true"'),
    record().replace("2020-01-01T00:00:00Z", "not-a-date"),
  ]) {
    const h = fixture(value);
    assert.equal(h.el("privacy-dialog").open, true);
    assert.deepEqual(h.changes.at(-1), {
      analytics: false,
      operationLogs: false,
    });
  }
});
test("blocked or unavailable storage remembers only in-page choice and explains repeat limitation", () => {
  for (const mode of ["blocked-read", "blocked-write"]) {
    const h = fixture(null, mode);
    h.el("privacy-operation-logs").checked = true;
    assert.doesNotThrow(() => h.el("privacy-allow").fire("click"));
    assert.deepEqual(h.changes.at(-1), {
      analytics: false,
      operationLogs: true,
    });
    assert.match(h.el("privacy-status").textContent, /저장하지 못했습니다/);
    assert.equal(h.el("privacy-dialog").open, false);
  }
});
test("cross-tab withdrawal, deletion and malformed storage stop collection without popup loops", () => {
  for (const value of [record(false, false), null, "broken"]) {
    const h = fixture(record(true, true));
    h.el("privacy-settings").fire("click");
    h.handlers.get("storage")({
      key: PRIVACY_STORAGE_KEY,
      newValue: value,
      storageArea: h.storage,
    });
    assert.deepEqual(h.changes.at(-1), {
      analytics: false,
      operationLogs: false,
    });
    assert.equal(h.el("privacy-dialog").open, false);
  }
  const h = fixture(record(true, true));
  h.handlers.get("storage")({ key: "other-setting", newValue: "broken" });
  assert.equal(h.changes.length, 1);
  h.handlers.get("storage")({ key: null, newValue: null });
  assert.deepEqual(h.changes.at(-1), {
    analytics: false,
    operationLogs: false,
  });
});
test("extra stored fields are discarded rather than reaching permission callbacks", () => {
  const parsed = parsePrivacyPreferences(
    record().replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"filename":"private.jpg"',
    ),
  );
  assert.doesNotMatch(JSON.stringify(parsed), /private|filename/);
});
