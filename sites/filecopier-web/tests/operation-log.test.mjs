import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  createOperationLogger,
  classifyOperationError,
} from "../dist/operation-log.mjs";
import { validateOperation } from "../dist/operation-schema.mjs";
import worker, {
  signRecord,
  runRetention,
} from "../../../server/operation-logs/worker.mjs";
const uuid = () => crypto.randomUUID();
const flush = () => new Promise((resolve) => setImmediate(resolve));
function payload() {
  return {
    schemaVersion: 1,
    sessionId: uuid(),
    operationId: uuid(),
    sequence: 2,
    clientTime: new Date().toISOString(),
    appVersion: "2026.10.19-logs-8",
    buildId: "bc2d587",
    browser: { name: "Chrome", majorVersion: "141" },
    mode: "copy",
    stage: "finished",
    result: "partial_failure",
    durationMs: 12000,
    files: {
      selected: 100,
      succeeded: 98,
      requested: 0,
      archived: 0,
      failed: 2,
      unprocessed: 0,
    },
    bytes: { selected: 3000000000, written: 2940000000, prepared: 0 },
    errors: [{ code: "WRITE_PERMISSION_DENIED", phase: "write", count: 2 }],
  };
}
function clientFixture(overrides = {}, consent = {}) {
  const sent = [];
  let now = 1000;
  const window = {
    location: { origin: "https://lucky2449.github.io" },
    crypto,
    navigator: { userAgent: "Mozilla secret/path Chrome/141.0" },
    fetch: async (url, opts) => {
      sent.push({ url, opts, value: JSON.parse(opts.body) });
      return new Response(null, { status: 201 });
    },
    ...overrides,
  };
  const logger = createOperationLogger({
    hasConsent: () => true,
    window,
    config: {
      endpoint: "https://collector.example/v1/operations",
      buildId: "bc2d587",
    },
    appVersion: "2026.10.19-logs-8",
    now: () => now,
    ...consent,
  });
  return { logger, sent, window, advance: () => (now += 1000) };
}
test("client sends start and one finish with matching IDs and no private error text", async () => {
  const f = clientFixture();
  const op = f.logger.begin("copy", {
    selectedCount: 100,
    selectedBytes: 3000000000,
  });
  op.error(
    new DOMException("C:/secret/photo.CR3 denied", "NotAllowedError"),
    "write",
  );
  op.error(new DOMException("private details", "NotAllowedError"), "write");
  f.advance();
  op.finish({
    result: "partial_failure",
    succeeded: 98,
    failed: 2,
    writtenBytes: 2940000000,
  });
  op.finish({ result: "success" });
  await flush();
  assert.equal(f.sent.length, 2);
  const [start, end] = f.sent.map((x) => x.value);
  assert.equal(start.operationId, end.operationId);
  assert.equal(start.sessionId, end.sessionId);
  assert.equal(start.sequence, 1);
  assert.equal(end.sequence, 2);
  assert.equal(end.durationMs, 1000);
  assert.equal(end.errors[0].count, 2);
  assert.doesNotMatch(
    JSON.stringify(f.sent),
    /secret|photo|private details|Mozilla/,
  );
  assert.equal(f.sent[0].opts.credentials, "omit");
  assert.equal(f.sent[0].opts.referrerPolicy, "no-referrer");
});
test("visit is a single record and requested downloads do not claim completion", async () => {
  const f = clientFixture();
  f.logger.visit();
  const op = f.logger.begin("zip", { selectedCount: 3, selectedBytes: 123 });
  op.finish({
    result: "download_requested",
    requested: 3,
    archived: 3,
    preparedBytes: 480,
  });
  await flush();
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[0].value.result, "visited");
  assert.equal(f.sent[2].value.files.succeeded, 0);
  assert.equal(f.sent[2].value.bytes.written, 0);
});
for (const variant of ["disabled", "wrong-origin", "unsafe-endpoint"]) {
  test(`logger ${variant} sends no requests`, async () => {
    let requests = 0;
    const window = {
      location: {
        origin:
          variant === "wrong-origin"
            ? "http://localhost:8080"
            : "https://lucky2449.github.io",
      },
      crypto,
      fetch: () => {
        requests++;
      },
    };
    const endpoint =
      variant === "disabled"
        ? ""
        : variant === "unsafe-endpoint"
          ? "http://example.com/v1/operations"
          : "https://example.com/v1/operations";
    const logger = createOperationLogger({
      hasConsent: () => true,
      window,
      config: { endpoint, buildId: "bc2d587" },
      appVersion: "2026.10.19-logs-8",
    });
    logger.visit();
    logger
      .begin("copy", { selectedCount: 1, selectedBytes: 4 })
      .finish({ result: "success", succeeded: 1, writtenBytes: 4 });
    await flush();
    assert.equal(requests, 0);
  });
}
test("network failure and pending limit never reject a file operation", async () => {
  const f = clientFixture({
    fetch: () => {
      throw new Error("offline");
    },
  });
  assert.doesNotThrow(() =>
    f.logger.begin("copy").finish({ result: "success" }),
  );
  await flush();
  await flush();
  let requests = 0;
  const g = clientFixture({
    fetch: () => {
      requests++;
      return new Promise(() => {});
    },
  });
  for (let i = 0; i < 20; i++) g.logger.visit();
  await flush();
  assert.equal(requests, 8);
});
test("error classification uses fixed codes and excludes unknown raw messages", () => {
  assert.equal(
    classifyOperationError(
      new DOMException("private", "QuotaExceededError"),
      "write",
    ),
    "STORAGE_FULL",
  );
  assert.equal(
    classifyOperationError(new Error("private"), "read"),
    "SOURCE_READ_FAILED",
  );
  assert.equal(
    classifyOperationError(new Error("private"), "close"),
    "CLOSE_FAILED",
  );
  assert.equal(
    classifyOperationError({ code: "SIZE_MISMATCH" }, "read"),
    "SIZE_MISMATCH",
  );
});
for (const field of ["filename", "path", "message", "ip"]) {
  test(`schema rejects unapproved top-level ${field}`, () => {
    const value = payload();
    value[field] = "secret";
    assert.throws(() => validateOperation(value));
  });
}
test("schema rejects nested private data, invalid counts and false download completion", () => {
  const v = payload();
  v.errors[0].message = "private";
  assert.throws(() => validateOperation(v));
  delete v.errors[0].message;
  v.files.succeeded = 999;
  assert.throws(() => validateOperation(v));
  v.files.succeeded = 98;
  v.mode = "download";
  assert.throws(() => validateOperation(v));
});
async function serverFixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    await readFile(
      new URL("../../../server/operation-logs/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  t.after(() => db.close());
  const env = {
    ALLOWED_ORIGIN: "https://lucky2449.github.io",
    LOG_SIGNING_KEY: "unit-test-signing-secret-32-characters",
    GLOBAL_LIMITER: { limit: async () => ({ success: true }) },
    SESSION_LIMITER: { limit: async () => ({ success: true }) },
    DB: {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async run() {
                const r = db.prepare(sql).run(...values);
                return { meta: { changes: Number(r.changes) } };
              },
            };
          },
        };
      },
    },
  };
  const send = (value = payload(), options = {}) =>
    worker.fetch(
      new Request("https://collector.example/v1/operations", {
        method: "POST",
        headers: {
          Origin: env.ALLOWED_ORIGIN,
          "Content-Type": "application/json",
          ...options.headers,
        },
        body: JSON.stringify(value),
        ...options,
      }),
      env,
    );
  return { db, env, send };
}
test("server stores signed records in real SQLite with its own receipt time, rejects duplicates", async (t) => {
  const { db, env, send } = await serverFixture(t);
  const value = payload();
  const before = Date.now();
  const response = await send(value);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.ok(Date.parse(receipt.receivedAt) >= before);
  assert.equal((await send(value)).status, 409);
  const row = db.prepare("SELECT * FROM operation_records").get();
  assert.equal(row.record_id, receipt.recordId);
  const signed = await signRecord(
    row.client_payload,
    row.record_id,
    row.received_at,
    env.LOG_SIGNING_KEY,
  );
  assert.equal(row.signature, signed.signature);
  assert.equal(row.payload_hash, signed.payloadHash);
  assert.notEqual(
    (
      await signRecord(
        row.client_payload + " ",
        row.record_id,
        row.received_at,
        env.LOG_SIGNING_KEY,
      )
    ).signature,
    row.signature,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM operation_records").get().n,
    1,
  );
});
test("server rejects wrong origins, public reads, oversize bodies and private fields without DB writes", async (t) => {
  const { db, env, send } = await serverFixture(t);
  assert.equal(
    (
      await send(payload(), {
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request("https://collector.example/v1/operations", {
          headers: { Origin: env.ALLOWED_ORIGIN },
        }),
        env,
      )
    ).status,
    405,
  );
  assert.equal((await send({ ...payload(), filename: "secret" })).status, 400);
  assert.equal((await send("x".repeat(5000))).status, 400);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM operation_records").get().n,
    0,
  );
});
test("server supports CORS preflight only for permitted origin and fails closed on missing secrets/rate limits", async (t) => {
  const { env, send } = await serverFixture(t);
  const response = await worker.fetch(
    new Request("https://collector.example/v1/operations", {
      method: "OPTIONS",
      headers: { Origin: env.ALLOWED_ORIGIN },
    }),
    env,
  );
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    env.ALLOWED_ORIGIN,
  );
  env.GLOBAL_LIMITER.limit = async () => ({ success: false });
  assert.equal((await send()).status, 429);
  delete env.LOG_SIGNING_KEY;
  assert.equal((await send()).status, 503);
});
test("D1 failure returns generic 503 without leaking SQL, secrets or submitted data", async (t) => {
  const { env, send } = await serverFixture(t);
  env.DB.prepare = () => {
    throw new Error("secret SQL path");
  };
  const response = await send();
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "");
});
test("retention only removes old records in bounded batches", async (t) => {
  const { db, env, send } = await serverFixture(t);
  await send();
  db.prepare("UPDATE operation_records SET received_at = ?").run(
    "2020-01-01T00:00:00.000Z",
  );
  await send();
  let task;
  await worker.scheduled(null, env, {
    waitUntil: (p) => {
      task = p;
    },
  });
  await task;
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM operation_records").get().n,
    1,
  );
});

test("client start/finish payloads pass real collector validation and SQLite persistence for all save modes", async (t) => {
  const { db, env } = await serverFixture(t);
  const pending = [];
  const f = clientFixture({
    fetch: (url, options) => {
      const task = worker.fetch(
        new Request(url, {
          ...options,
          headers: { ...options.headers, Origin: env.ALLOWED_ORIGIN },
        }),
        env,
      );
      pending.push(task);
      return task;
    },
  });
  f.logger.visit();
  for (const mode of ["copy", "download", "zip"]) {
    const op = f.logger.begin(mode, { selectedCount: 3, selectedBytes: 123 });
    if (mode === "copy")
      op.finish({
        result: "partial_failure",
        succeeded: 2,
        failed: 1,
        writtenBytes: 82,
      });
    else
      op.finish({
        result: "download_requested",
        requested: 3,
        archived: mode === "zip" ? 3 : 0,
        preparedBytes: mode === "zip" ? 480 : 0,
      });
  }
  await flush();
  const responses = await Promise.all(pending);
  assert.ok(responses.every((r) => r.status === 201));
  const rows = db.prepare("SELECT client_payload FROM operation_records").all();
  assert.equal(rows.length, 7);
  assert.equal(
    rows.filter((r) => JSON.parse(r.client_payload).stage === "started").length,
    3,
  );
});
test("collector rejects inconsistent success claims", async (t) => {
  const { send } = await serverFixture(t);
  const value = payload();
  value.result = "success";
  assert.equal((await send(value)).status, 400);
});

test("retention records successful execution and remaining backlog without deleting recent records", async (t) => {
  const { db, env, send } = await serverFixture(t);
  await send();
  db.prepare("UPDATE operation_records SET received_at=?").run(
    "2020-01-01T00:00:00.000Z",
  );
  await send();
  await runRetention(env);
  const run = db.prepare("SELECT * FROM maintenance_runs").get();
  assert.equal(run.status, "success");
  assert.equal(run.rows_deleted, 1);
  assert.equal(run.expired_remaining, 0);
  assert.ok(run.finished_at);
  assert.equal(
    db.prepare("SELECT count(*) n FROM operation_records").get().n,
    1,
  );
});

test("retention failure is recorded and rethrown without removing records", async (t) => {
  const { db, env, send } = await serverFixture(t);
  await send();
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql.startsWith("DELETE FROM operation_records"))
      throw new Error("simulated D1 failure");
    return prepare(sql);
  };
  await assert.rejects(runRetention(env), /simulated/);
  const run = db.prepare("SELECT * FROM maintenance_runs").get();
  assert.equal(run.status, "failed");
  assert.equal(run.error_code, "RETENTION_FAILED");
  assert.equal(
    db.prepare("SELECT count(*) n FROM operation_records").get().n,
    1,
  );
});

test("operator views separate synthetic events, missing pairs and fixed error counts", async (t) => {
  const { db, send } = await serverFixture(t);
  db.exec(
    await readFile(
      new URL("../../../server/operation-logs/ops-views.sql", import.meta.url),
      "utf8",
    ),
  );
  const end = payload();
  await send(end);
  const synthetic = payload();
  synthetic.appVersion = "2026.10.19-ops-0";
  await send(synthetic);
  assert.equal(
    db.prepare("SELECT records_24h FROM log_ops_summary").get().records_24h,
    1,
  );
  assert.equal(
    db.prepare("SELECT occurrences FROM log_ops_errors").get().occurrences,
    2,
  );
  assert.equal(
    db.prepare("SELECT sum(records) n FROM log_ops_gaps").get().n,
    0,
  );
  db.prepare("UPDATE operation_records SET received_at=?").run(
    new Date(Date.now() - 3600000).toISOString(),
  );
  assert.equal(
    db
      .prepare(
        "SELECT records FROM log_ops_gaps WHERE kind='missing_start_after_10m'",
      )
      .get().records,
    1,
  );
  const start = {
    ...end,
    sequence: 1,
    stage: "started",
    result: "started",
    durationMs: 0,
    files: { ...end.files, succeeded: 0, failed: 0, unprocessed: 100 },
    bytes: { ...end.bytes, written: 0 },
    errors: [],
  };
  assert.equal((await send(start)).status, 201);
  assert.equal(
    db.prepare("SELECT sum(records) n FROM log_ops_gaps").get().n,
    0,
  );
  db.prepare("DELETE FROM operation_records WHERE sequence=2").run();
  db.prepare("UPDATE operation_records SET received_at=?").run(
    new Date(Date.now() - 25 * 3600000).toISOString(),
  );
  assert.equal(
    db
      .prepare(
        "SELECT records FROM log_ops_gaps WHERE kind='missing_finish_after_24h'",
      )
      .get().records,
    1,
  );
});

test("retention caps a run at 5000 and expires only old maintenance summaries", async (t) => {
  const { db, env, send } = await serverFixture(t);
  await send();
  db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5001)
    INSERT INTO operation_records SELECT 'old-'||x,'2020-01-01T00:00:00.000Z',session_id,'op-'||x,
      sequence,mode,result,build_id,client_payload,payload_hash,signature FROM n,operation_records WHERE record_id NOT LIKE 'old-%'`);
  db.prepare(
    "INSERT INTO maintenance_runs(run_id,started_at,status) VALUES('old','2020-01-01T00:00:00.000Z','success')",
  ).run();
  await runRetention(env);
  const run = db.prepare("SELECT * FROM maintenance_runs").all();
  assert.equal(run.length, 1);
  assert.equal(run[0].rows_deleted, 5000);
  assert.equal(run[0].expired_remaining, 1);
  assert.equal(
    db.prepare("SELECT count(*) n FROM operation_records").get().n,
    2,
  );
});
test("logger defaults denied and never backfills operations started before consent", async () => {
  const f = clientFixture({}, { hasConsent: () => false });
  createOperationLogger({window:f.window,config:{endpoint:"https://collector.example/v1/operations",buildId:"bc2d587"},appVersion:"2026.10.19-logs-8"}).visit();
  f.logger.visit();
  f.logger
    .begin("copy", { selectedCount: 1, selectedBytes: 1 })
    .finish({ result: "success", succeeded: 1, writtenBytes: 1 });
  await flush();
  assert.equal(f.sent.length, 0);
  let allowed = false,
    revision = 0;
  const g = clientFixture(
    {},
    { hasConsent: () => allowed, consentRevision: () => revision },
  );
  const op = g.logger.begin("copy", { selectedCount: 1, selectedBytes: 1 });
  allowed = true;
  revision++;
  op.finish({ result: "success", succeeded: 1, writtenBytes: 1 });
  await flush();
  assert.equal(g.sent.length, 0);
});
test("revocation before queued send blocks it; re-consent never resumes an old operation", async () => {
  let allowed = true,
    revision = 0;
  const f = clientFixture(
    {},
    { hasConsent: () => allowed, consentRevision: () => revision },
  );
  const op = f.logger.begin("copy", { selectedCount: 1, selectedBytes: 1 });
  allowed = false;
  revision++;
  f.logger.stop();
  await flush();
  assert.equal(f.sent.length, 0);
  allowed = true;
  revision++;
  op.finish({ result: "success", succeeded: 1, writtenBytes: 1 });
  await flush();
  assert.equal(f.sent.length, 0);
  f.logger.visit();
  await flush();
  assert.equal(f.sent.length, 1);
});


test("wire logs omit actual byte totals and never link separate operations", async () => {
  const f = clientFixture();
  const first = f.logger.begin("copy", { selectedCount: 1, selectedBytes: 987654321 });
  first.finish({ result: "success", succeeded: 1, writtenBytes: 987654321 });
  const second = f.logger.begin("copy", { selectedCount: 1, selectedBytes: 123456789 });
  second.finish({ result: "success", succeeded: 1, writtenBytes: 123456789 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.sent.length, 4);
  for (const { value } of f.sent) assert.deepEqual(value.bytes, { selected: 0, written: 0, prepared: 0 });
  assert.notEqual(f.sent[0].value.sessionId, f.sent[2].value.sessionId);
  assert.equal(f.sent[0].value.sessionId, f.sent[1].value.sessionId);
});
