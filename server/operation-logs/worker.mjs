import { validateOperation } from "../../sites/filecopier-web/dist/operation-schema.mjs";
const encoder = new TextEncoder();
const hex = (bytes) =>
  [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export async function signRecord(payload, recordId, receivedAt, secret) {
  const payloadHash = hex(
    await crypto.subtle.digest("SHA-256", encoder.encode(payload)),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(recordId + "\n" + receivedAt + "\n" + payloadHash),
    ),
  );
  return { payloadHash, signature };
}
async function readLimited(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty");
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new Error("large");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}
export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || "https://lucky2449.github.io";
    const origin = request.headers.get("Origin");
    const headers = {
      "Cache-Control": "no-store",
      Vary: "Origin",
      "X-Content-Type-Options": "nosniff",
    };
    if (origin === allowed) headers["Access-Control-Allow-Origin"] = allowed;
    const reply = (status, data) =>
      new Response(data ? JSON.stringify(data) : null, {
        status,
        headers: {
          ...headers,
          ...(data ? { "Content-Type": "application/json" } : {}),
        },
      });
    if (new URL(request.url).pathname !== "/v1/operations") return reply(404);
    if (origin !== allowed) return reply(403);
    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        },
      });
    if (request.method !== "POST") return reply(405);
    if (
      !(request.headers.get("Content-Type") || "")
        .toLowerCase()
        .startsWith("application/json")
    )
      return reply(415);
    if (
      !env.DB ||
      !env.GLOBAL_LIMITER ||
      !env.SESSION_LIMITER ||
      typeof env.LOG_SIGNING_KEY !== "string" ||
      env.LOG_SIGNING_KEY.length < 32
    )
      return reply(503);
    try {
      if (!(await env.GLOBAL_LIMITER.limit({ key: "operation-logs" })).success)
        return reply(429);
      let value;
      try {
        value = validateOperation(await readLimited(request));
      } catch {
        return reply(400);
      }
      if (!(await env.SESSION_LIMITER.limit({ key: value.sessionId })).success)
        return reply(429);
      const recordId = crypto.randomUUID(),
        receivedAt = new Date().toISOString(),
        payload = JSON.stringify(value);
      const { payloadHash, signature } = await signRecord(
        payload,
        recordId,
        receivedAt,
        env.LOG_SIGNING_KEY,
      );
      const result = await env.DB.prepare(
        `INSERT INTO operation_records
    (record_id, received_at, session_id, operation_id, sequence, mode, result, build_id, client_payload, payload_hash, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, operation_id, sequence) DO NOTHING`,
      )
        .bind(
          recordId,
          receivedAt,
          value.sessionId,
          value.operationId,
          value.sequence,
          value.mode,
          value.result,
          value.buildId,
          payload,
          payloadHash,
          signature,
        )
        .run();
      if (result.meta.changes !== 1) return reply(409);
      return reply(201, { recordId, receivedAt });
    } catch {
      return reply(503);
    }
  },
  async scheduled(controller, env, ctx) {
    // Bounded daily retention cleanup; retention changes require updating the site notice too.
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    ctx.waitUntil(
      env.DB.prepare(
        "DELETE FROM operation_records WHERE record_id IN (SELECT record_id FROM operation_records WHERE received_at < ? ORDER BY received_at LIMIT 5000)",
      )
        .bind(cutoff)
        .run(),
    );
  },
};
