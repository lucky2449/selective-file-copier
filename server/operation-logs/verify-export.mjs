// Verify a D1 query export containing operation_records rows. Run locally only.
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { signRecord } from "./worker.mjs";
const secret = process.env.LOG_SIGNING_KEY;
if (!secret)
  throw new Error("LOG_SIGNING_KEY environment variable is required");
const data = JSON.parse(await readFile(process.argv[2], "utf8"));
const rows = Array.isArray(data) && data[0]?.results ? data[0].results : data;
if (!Array.isArray(rows))
  throw new Error("Expected row array or Wrangler query JSON");
for (const row of rows) {
  const payload = JSON.parse(row.client_payload);
  for (const [column, key] of [
    ["session_id", "sessionId"],
    ["operation_id", "operationId"],
    ["sequence", "sequence"],
    ["mode", "mode"],
    ["result", "result"],
    ["build_id", "buildId"],
  ]) {
    if (row[column] !== payload[key])
      throw new Error("Record metadata mismatch");
  }
  const signed = await signRecord(
    row.client_payload,
    row.record_id,
    row.received_at,
    secret,
  );
  if (
    signed.payloadHash !== row.payload_hash ||
    typeof row.signature !== "string" ||
    row.signature.length !== 64 ||
    !timingSafeEqual(Buffer.from(signed.signature), Buffer.from(row.signature))
  )
    throw new Error("Record verification failed");
}
console.log(
  `Verified ${rows.length} exported records. This does not prove client truth or detect deleted records.`,
);
