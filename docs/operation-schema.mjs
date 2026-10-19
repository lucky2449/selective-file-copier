// Shared strict wire format. Reject extra keys rather than persist raw objects.
export const ERROR_CODES = new Set([
  "STORAGE_FULL",
  "WRITE_PERMISSION_DENIED",
  "SOURCE_READ_FAILED",
  "DESTINATION_UNAVAILABLE",
  "SIZE_MISMATCH",
  "WRITE_FAILED",
  "CLOSE_FAILED",
  "LOCATION_CHECK_FAILED",
  "DOWNLOAD_REQUEST_FAILED",
  "UNKNOWN",
]);
export const PHASES = new Set([
  "location-check",
  "open",
  "read",
  "write",
  "close",
  "download",
  "prepare",
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function keys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...expected].sort().join()
  )
    throw new Error("Invalid fields");
}
const integer = (v, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(v) || v < 0 || v > max)
    throw new Error("Invalid count");
};
export function validateOperation(value) {
  keys(value, [
    "schemaVersion",
    "sessionId",
    "operationId",
    "sequence",
    "clientTime",
    "appVersion",
    "buildId",
    "browser",
    "mode",
    "stage",
    "result",
    "durationMs",
    "files",
    "bytes",
    "errors",
  ]);
  if (
    value.schemaVersion !== 1 ||
    !uuid.test(value.sessionId) ||
    !uuid.test(value.operationId)
  )
    throw new Error("Invalid IDs");
  if (
    !/^\d{4}\.\d{2}\.\d{2}-[a-z]+-\d{1,4}$/.test(value.appVersion) ||
    !/^([0-9a-f]{7,40}|unversioned)$/.test(value.buildId)
  )
    throw new Error("Invalid version");
  if (
    typeof value.clientTime !== "string" ||
    value.clientTime.length !== 24 ||
    !Number.isFinite(Date.parse(value.clientTime)) ||
    new Date(value.clientTime).toISOString() !== value.clientTime
  )
    throw new Error("Invalid time");
  keys(value.browser, ["name", "majorVersion"]);
  if (
    !["Chrome", "Edge", "Firefox", "Safari", "Other"].includes(
      value.browser.name,
    ) ||
    !/^([0-9]{1,3}|unknown)$/.test(value.browser.majorVersion)
  )
    throw new Error("Invalid browser");
  if (
    !["visit", "copy", "download", "zip"].includes(value.mode) ||
    !["started", "finished"].includes(value.stage)
  )
    throw new Error("Invalid mode");
  if (
    ![
      "started",
      "success",
      "partial_failure",
      "failed",
      "cancelled",
      "download_requested",
      "visited",
    ].includes(value.result)
  )
    throw new Error("Invalid result");
  if (
    value.sequence !== (value.stage === "started" ? 1 : 2) ||
    (value.stage === "started" && value.result !== "started") ||
    (value.stage === "finished" && value.result === "started")
  )
    throw new Error("Invalid sequence");
  integer(value.durationMs, 7 * 86400000);
  keys(value.files, [
    "selected",
    "succeeded",
    "requested",
    "archived",
    "failed",
    "unprocessed",
  ]);
  for (const count of Object.values(value.files)) integer(count, 10000000);
  const f = value.files;
  if (
    f.succeeded + f.requested + f.failed + f.unprocessed !== f.selected ||
    f.archived > f.selected
  )
    throw new Error("Inconsistent files");
  if (
    (value.mode !== "copy" && f.succeeded !== 0) ||
    (value.mode === "copy" && (f.requested || f.archived)) ||
    (value.mode !== "zip" && f.archived)
  )
    throw new Error("Invalid completion claim");
  keys(value.bytes, ["selected", "written", "prepared"]);
  for (const size of Object.values(value.bytes)) integer(size);
  if (
    value.bytes.written > value.bytes.selected ||
    (value.mode !== "copy" && value.bytes.written)
  )
    throw new Error("Invalid byte claim");
  if (!Array.isArray(value.errors) || value.errors.length > 30)
    throw new Error("Invalid errors");
  for (const error of value.errors) {
    keys(error, ["code", "phase", "count"]);
    if (!ERROR_CODES.has(error.code) || !PHASES.has(error.phase))
      throw new Error("Invalid error");
    integer(error.count, 10000000);
    if (!error.count) throw new Error("Invalid error count");
  }
  if (
    value.mode === "visit" &&
    (value.stage !== "finished" ||
      value.result !== "visited" ||
      Object.values(f).some(Boolean) ||
      Object.values(value.bytes).some(Boolean) ||
      value.errors.length)
  )
    throw new Error("Invalid visit");
  if (
    value.stage === "started" &&
    (f.succeeded ||
      f.failed ||
      f.requested ||
      f.archived ||
      value.bytes.written ||
      value.bytes.prepared ||
      value.errors.length ||
      value.durationMs)
  )
    throw new Error("Invalid start");
  if (value.stage === "finished") {
    if (
      value.result === "success" &&
      (value.mode !== "copy" || f.failed || f.unprocessed)
    )
      throw new Error("Invalid success claim");
    if (
      value.result === "download_requested" &&
      (!["download", "zip"].includes(value.mode) || f.failed || f.unprocessed)
    )
      throw new Error("Invalid download claim");
    if (value.result === "visited" && value.mode !== "visit")
      throw new Error("Invalid visit claim");
  }
  return value;
}
