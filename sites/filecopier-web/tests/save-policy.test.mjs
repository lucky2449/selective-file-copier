import test from "node:test";
import assert from "node:assert/strict";
import {
  createSaveNotice,
  createDiagnostics,
  assertSafeDestination,
} from "../dist/save-policy.mjs";
test("notice cancels without acceptance, persists acceptance and tolerates blocked storage", () => {
  let calls = 0,
    stored = null,
    approve = false;
  const env = {
    confirm: () => {
      calls++;
      return approve;
    },
    localStorage: { getItem: () => stored, setItem: (k, v) => (stored = v) },
  };
  const ask = createSaveNotice(env);
  assert.equal(ask(), false);
  assert.equal(stored, null);
  approve = true;
  assert.equal(ask(), true);
  assert.equal(ask(), true);
  assert.equal(calls, 2);
  assert.equal(createSaveNotice(env)(), true);
  assert.equal(calls, 2);
  const blocked = createSaveNotice({
    confirm: () => true,
    get localStorage() {
      throw new Error("denied");
    },
  });
  assert.equal(blocked(), true);
});
for (const scenario of [
  "no-source",
  "same",
  "source-child",
  "source-parent",
  "unverifiable",
  "denied",
]) {
  test(`strict location guard rejects ${scenario}`, async () => {
    const source = {
      isSameEntry: async () => scenario === "same",
      resolve: async () => (scenario === "source-child" ? ["child"] : null),
    };
    const destination = {
      resolve: async () => {
        if (scenario === "denied") throw new Error("denied");
        return scenario === "source-parent" ? ["source"] : null;
      },
    };
    if (scenario === "unverifiable") delete destination.resolve;
    await assert.rejects(
      assertSafeDestination(
        scenario === "no-source" ? null : source,
        destination,
      ),
    );
  });
}
test("strict location guard allows verified disjoint folders", async () => {
  await assertSafeDestination(
    { isSameEntry: async () => false, resolve: async () => null },
    { resolve: async () => null },
  );
});
test("diagnostics whitelist excludes paths, raw errors, full UA and caps history", () => {
  const d = createDiagnostics("Chrome/123 secret-user-info");
  d.record("C:/private/photo.jpg", "failed");
  d.record("copy", "private error");
  for (let i = 0; i < 210; i++) d.record("copy", "writing");
  const raw = d.export(),
    data = JSON.parse(raw);
  assert.equal(data.entries.length, 200);
  assert.equal(data.browser, "Chrome");
  assert.doesNotMatch(raw, /private|secret-user|Chrome\//);
});
