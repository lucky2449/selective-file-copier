import test from "node:test";
import assert from "node:assert/strict";
import { createSaveNotice, createDiagnostics } from "../dist/save-policy.mjs";
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

test("save warning follows permission changes during the current page session", () => {
  let enabled = false, message = "";
  const ask = createSaveNotice({ confirm(text) { message = text; return true; } }, { operationLogsEnabled: () => enabled });
  ask(); assert.doesNotMatch(message, /Cloudflare/);
  enabled = true;
  ask(); assert.match(message, /허용한.*Cloudflare/);
  enabled = false;
  ask(); assert.doesNotMatch(message, /Cloudflare/);
});

test("updated save notice reappears after legacy acceptance and describes enabled server collection", () => {
  let stored = "1",
    message = "",
    calls = 0;
  const env = {
    localStorage: {
      getItem: () => stored,
      setItem: (key, value) => (stored = value),
    },
    confirm: (text) => {
      message = text;
      calls++;
      return true;
    },
  };
  const ask = createSaveNotice(env, {
    operationLogsEnabled: true,
    retentionDays: 90,
  });
  assert.equal(ask(), true);
  assert.equal(calls, 1);
  assert.match(message, /허용한/);
  assert.match(message, /Cloudflare/);
  assert.match(message, /90일/);
  assert.match(
    message,
    /파일 내용·이름·경로·입력 목록은 서버로 보내지 않습니다/,
  );
  assert.ok(message.length < 300, "Save warning stays concise");
  assert.equal(ask(), true);
  assert.equal(calls, 1);
  assert.equal(
    createSaveNotice(env, { operationLogsEnabled: true, retentionDays: 90 })(),
    true,
  );
  assert.equal(calls, 1);
  assert.equal(
    createSaveNotice(env, { operationLogsEnabled: true, retentionDays: 30 })(),
    true,
  );
  assert.equal(calls, 2);
});
test("local-only notice does not claim server collection and enabling logs requires new acknowledgement", () => {
  let stored = null,
    message = "",
    calls = 0;
  const env = {
    localStorage: { getItem: () => stored, setItem: (k, v) => (stored = v) },
    confirm: (text) => {
      message = text;
      calls++;
      return true;
    },
  };
  createSaveNotice(env)();
  assert.doesNotMatch(message, /Cloudflare/);
  createSaveNotice(env, { operationLogsEnabled: true })();
  assert.equal(calls, 2);
  assert.match(message, /Cloudflare/);
});
