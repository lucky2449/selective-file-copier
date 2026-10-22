import assert from "node:assert/strict";
import test from "node:test";
import { createAnalytics } from "../dist/analytics.mjs";

const ID = "G-TEST123456";
function fixture(measurementId = ID, origin = "https://lucky2449.github.io") {
  const scripts = [];
  const window = {
    location: {
      origin,
      search: "?secret=private-photo.jpg",
      hash: "#private-folder",
    },
  };
  const document = {
    title: "private-file.jpg",
    referrer: "https://example.com/private-folder",
    createElement: () => ({}),
    head: { append: (script) => scripts.push(script) },
  };
  const analytics = createAnalytics({ measurementId, window, document });
  analytics.setConsent(true);
  return {
    analytics,
    window,
    document,
    scripts,
    commands: () => (window.dataLayer ?? []).map((args) => Array.from(args)),
  };
}

test("no ID, invalid IDs and local sites never load or queue GA4", () => {
  for (const [id, origin] of [
    ["", "https://lucky2449.github.io"],
    ["G-bad<script>", "https://lucky2449.github.io"],
    [ID, "http://127.0.0.1:8080"],
    [ID, "https://filecopier-browser.example.com"],
  ]) {
    const h = fixture(id, origin);
    h.analytics.start();
    h.analytics.track("file_search");
    assert.equal(h.analytics.configured, false);
    assert.equal(h.scripts.length, 0);
    assert.deepEqual(h.commands(), []);
  }
});

test("GA4 disables automatic pageviews and advertising and counts one visit", () => {
  const h = fixture();
  h.analytics.start();
  h.analytics.start();
  h.analytics.track("page_view");
  assert.equal(h.scripts.length, 1);
  assert.equal(
    h.scripts[0].src,
    `https://www.googletagmanager.com/gtag/js?id=${ID}`,
  );
  assert.equal(h.scripts[0].referrerPolicy, "no-referrer");
  const consent = h.commands().find(([command]) => command === "consent")[2];
  assert.equal(consent.analytics_storage, "granted");
  assert.equal(consent.ad_storage, "denied");
  assert.equal(consent.ad_user_data, "denied");
  assert.equal(consent.ad_personalization, "denied");
  const config = h.commands().find(([command]) => command === "config")[2];
  assert.equal(config.send_page_view, false);
  assert.equal(config.allow_google_signals, false);
  assert.equal(config.allow_ad_personalization_signals, false);
  assert.equal(h.commands().filter(([type]) => type === "event").length, 1);
});

test("only approved events and fixed metadata are queued, never file data or query strings", () => {
  const h = fixture();
  h.analytics.start();
  for (const event of [
    "file_search",
    "copy_success",
    "copy_failure",
    "download_request",
    "zip_created",
  ]) {
    h.analytics.track(
      event,
      event === "copy_success"
        ? 1000
        : event === "copy_failure"
          ? 2
          : undefined,
      {
        file_name: "private-photo.jpg",
        folder: "private-folder",
        error: "secret",
      },
    );
  }
  h.analytics.track("private-photo.jpg");
  h.analytics.track({ file: "private-photo.jpg" });
  const events = h.commands().filter(([command]) => command === "event");
  assert.deepEqual(
    events.map(([, name]) => name),
    [
      "page_view",
      "file_search",
      "copy_success",
      "copy_failure",
      "download_request",
      "zip_created",
    ],
  );
  for (const [, name, params] of events)
    assert.deepEqual(params, {
      send_to: ID,
      page_location: "https://lucky2449.github.io/selective-file-copier/",
      page_title: "파일모아",
      page_referrer: "",
      ...(name === "copy_success" ? { copied_file_count: 1000 } : {}),
      ...(name === "copy_failure" ? { failed_file_count: 2 } : {}),
    });
  assert.doesNotMatch(JSON.stringify(h.commands()), /private|secret/);
});

test("separate copy operations retain their own counts and analytics failures never escape", () => {
  const h = fixture();
  h.analytics.start();
  h.analytics.recordCopyResult(1000, 0);
  h.analytics.recordCopyResult(500, 0);
  assert.equal(
    h.commands().filter(([, name]) => name === "copy_success").length,
    2,
  );
  h.scripts[0].onerror();
  const count = h.commands().length;
  h.analytics.track("file_search");
  assert.equal(h.commands().length, count);
  const blocked = fixture();
  blocked.document.head.append = () => {
    throw new Error("Blocked");
  };
  assert.doesNotThrow(() => blocked.analytics.start());
  assert.doesNotThrow(() => blocked.analytics.track("file_search"));
  const broken = fixture();
  broken.analytics.start();
  broken.window.dataLayer.push = () => {
    throw new Error("Blocked queue");
  };
  assert.doesNotThrow(() => broken.analytics.track("file_search"));
});

test("copy summaries accept only positive safe integer counts", () => {
  const h = fixture();
  h.analytics.start();
  for (const count of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    "1000",
    {},
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    h.analytics.recordCopyResult(count, count);
  }
  assert.equal(h.commands().filter(([type]) => type === "event").length, 1);
  h.analytics.recordCopyResult(1000, 3);
  const summary = h
    .commands()
    .filter(([type, name]) => type === "event" && name.startsWith("copy_"));
  assert.equal(summary.length, 2);
  assert.equal(summary[0][2].copied_file_count, 1000);
  assert.equal(summary[1][2].failed_file_count, 3);
});

test("unanswered and revoked analytics never load or queue events; regrant does not duplicate scripts", () => {
  const h = fixture();
  h.analytics.setConsent(false);
  h.analytics.start();
  h.analytics.track("file_search");
  assert.equal(h.scripts.length, 0);
  assert.deepEqual(h.commands(), []);
  assert.equal(h.window[`ga-disable-${ID}`], true);
  h.analytics.setConsent(true);
  h.analytics.start();
  assert.equal(h.scripts.length, 1);
  const before = h.commands().length;
  h.analytics.setConsent(false);
  h.analytics.track("file_search");
  h.analytics.recordCopyResult(1000, 1);
  assert.equal(h.window[`ga-disable-${ID}`], true);
  assert.equal(h.commands().length, before);
  h.analytics.setConsent(true);
  h.analytics.start();
  h.analytics.track("file_search");
  assert.equal(h.scripts.length, 1);
  assert.equal(h.commands().filter(([, name]) => name === "page_view").length, 1);
  assert.equal(h.commands().filter(([, name]) => name === "file_search").length, 1);
});
test("a raw analytics instance fails closed by default", () => {
  const h = fixture();
  const analytics = createAnalytics({ measurementId: ID, window: h.window, document: h.document });
  analytics.start();
  analytics.track("file_search");
  assert.equal(h.scripts.length, 0);
  assert.deepEqual(h.commands(), []);
});
