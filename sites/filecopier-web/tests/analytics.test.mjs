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
    h.analytics.track(event, {
      file_name: "private-photo.jpg",
      folder: "private-folder",
      error: "secret",
    });
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
  for (const [, , params] of events)
    assert.deepEqual(params, {
      send_to: ID,
      page_location: "https://lucky2449.github.io/selective-file-copier/",
      page_title: "파일모아",
      page_referrer: "",
    });
  assert.doesNotMatch(JSON.stringify(h.commands()), /private|secret/);
});

test("repeat file events are counted individually, loader and queue failures never escape", () => {
  const h = fixture();
  h.analytics.start();
  h.analytics.track("copy_success");
  h.analytics.track("copy_success");
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
