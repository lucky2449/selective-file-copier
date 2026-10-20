import test from "node:test";
import assert from "node:assert/strict";
import {
  createPrivacy,
  privacyReady,
  PRIVACY_KEY,
  bindPrivacy,
} from "../dist/privacy.mjs";
const config = () => ({
  policyVersion: "test-1",
  operatorName: "Test",
  contactEmail: "test@example.com",
  consentDays: 180,
  analytics: {
    recipient: "Google LLC",
    contact: "https://example.com/google",
    countries: ["미국"],
    retentionMonths: 2,
    verified: true,
  },
  logs: {
    recipient: "Cloudflare",
    contact: "https://example.com/cf",
    countries: ["미국"],
    retentionDays: 90,
    verified: true,
  },
});
function fixture(c = config(), storage = new Map()) {
  let now = 1000;
  const handlers = {},
    timers = [];
  const window = {
    localStorage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
    },
    addEventListener: (k, fn) => (handlers[k] = fn),
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout() {},
  };
  return {
    c,
    window,
    storage,
    handlers,
    timers,
    advance: (ms) => (now += ms),
    create: () => createPrivacy({ window, config: c, now: () => now }),
  };
}
const all = {
  analyticsUse: true,
  analyticsTransfer: true,
  logsUse: true,
  logsTransfer: true,
};
test("new users and legacy save acceptance never authorize collection", () => {
  const f = fixture();
  f.storage.set("filemoa-save-notice", "2:logs-90");
  const p = f.create();
  assert.equal(p.decided, false);
  assert.equal(p.allowed("analytics"), false);
  assert.equal(p.allowed("logs"), false);
});
test("collection and transfer choices are separate, independently enforced per provider", () => {
  const f = fixture(),
    p = f.create();
  p.save({ analyticsUse: true, logsUse: true, logsTransfer: true });
  assert.equal(p.allowed("analytics"), false);
  assert.equal(p.allowed("logs"), true);
  p.save({ analyticsUse: true, analyticsTransfer: true });
  assert.equal(p.allowed("analytics"), true);
  assert.equal(p.allowed("logs"), false);
});
test("unknown countries, retention, or unverified config cannot be enabled through UI state", () => {
  for (const change of [
    (c) => (c.analytics.countries = []),
    (c) => (c.analytics.retentionMonths = null),
    (c) => (c.analytics.verified = false),
  ]) {
    const c = config();
    change(c);
    const f = fixture(c),
      p = f.create();
    p.save(all);
    assert.equal(privacyReady(c, "analytics"), false);
    assert.equal(p.allowed("analytics"), false);
    assert.equal(p.choices.analyticsUse, false);
  }
});
test("version or any policy-fact change invalidates past consent and does not assume renewal", () => {
  const f = fixture(),
    p = f.create();
  p.save(all);
  assert.equal(f.create().allowed("analytics"), true);
  f.c.analytics.countries = ["다른 국가"];
  assert.equal(f.create().allowed("analytics"), false);
});
test("expired choices stop collection and trigger active-tab revocation", () => {
  const f = fixture(),
    p = f.create();
  let notified = 0;
  p.subscribe(() => notified++);
  p.save(all);
  f.advance(180 * 86400000 + 1);
  f.timers.at(-1)();
  assert.equal(p.allowed("analytics"), false);
  assert.equal(p.decided, false);
  assert.equal(notified, 2);
});
test("other-tab withdrawal or storage clearing updates permission and revision", () => {
  const f = fixture(),
    p = f.create();
  p.save(all);
  const revision = p.revision;
  f.handlers.storage({ key: PRIVACY_KEY, newValue: null });
  assert.equal(p.allowed("logs"), false);
  assert.ok(p.revision > revision);
  p.save(all);
  f.handlers.storage({ key: null, newValue: null });
  assert.equal(p.allowed("analytics"), false);
});
test("broken/blocked storage remains denied initially; explicit choice works only in current tab", () => {
  const f = fixture();
  f.window.localStorage = {
    getItem() {
      throw Error();
    },
    setItem() {
      throw Error();
    },
  };
  const p = f.create();
  assert.equal(p.allowed("analytics"), false);
  p.save(all);
  assert.equal(p.allowed("analytics"), true);
  assert.equal(f.create().allowed("analytics"), false);
});
test("tampered stored consent with missing fields or invalid expiry is ignored", () => {
  const f = fixture(),
    p = f.create();
  p.save(all);
  const record = JSON.parse(f.storage.get(PRIVACY_KEY));
  record.expires += 1;
  f.storage.set(PRIVACY_KEY, JSON.stringify(record));
  assert.equal(f.create().decided, false);
});
test("privacy panel starts unchecked and saves rejection without blocking core UI", () => {
  const f = fixture(),
    p = f.create(),
    elements = new Map();
  const get = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        hidden: true,
        handlers: {},
        addEventListener(k, fn) {
          this.handlers[k] = fn;
        },
      });
    return elements.get(id);
  };
  bindPrivacy({
    window: f.window,
    document: { getElementById: get },
    config: f.c,
    privacy: p,
  });
  assert.equal(get("privacy-panel").hidden, false);
  assert.equal(get("privacy-analyticsUse").checked, false);
  get("privacy-reject").handlers.click();
  assert.equal(get("privacy-panel").hidden, true);
  assert.equal(p.allowed("analytics"), false);
  get("privacy-settings").handlers.click();
  assert.equal(get("privacy-panel").hidden, false);
});


test("explicit operator resume still requires separate consent and preserves unknown country facts", () => {
  const c = config();
  c.analytics.verified = false;
  c.analytics.countries = [];
  c.analytics.collectionEnabled = true;
  c.analytics.processingScope = "Actual countries unconfirmed";
  const f = fixture(c), p = f.create();
  assert.equal(privacyReady(c, "analytics"), true);
  assert.equal(p.allowed("analytics"), false);
  p.save({ analyticsUse: true });
  assert.equal(p.allowed("analytics"), false);
  p.save(all);
  assert.equal(p.allowed("analytics"), true);
  p.save({});
  assert.equal(p.allowed("analytics"), false);
  assert.deepEqual(c.analytics.countries, []);
  assert.equal(c.analytics.verified, false);
  c.analytics.processingScope = "";
  assert.equal(privacyReady(c, "analytics"), false);
});


test("published config disables both providers even with old full consent", async () => {
  const { privacyConfig } = await import("../dist/privacy-config.mjs");
  const f = fixture(privacyConfig), p = f.create();
  p.save(all);
  assert.equal(p.allowed("analytics"), false);
  assert.equal(p.allowed("logs"), false);
});
