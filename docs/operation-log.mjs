import { validateOperation, ERROR_CODES, PHASES } from "./operation-schema.mjs";
export function classifyOperationError(error, phase) {
  if (ERROR_CODES.has(error?.code)) return error.code;
  const name = error?.name;
  if (name === "QuotaExceededError") return "STORAGE_FULL";
  if (name === "NotReadableError" || phase === "read")
    return "SOURCE_READ_FAILED";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "WRITE_PERMISSION_DENIED";
  if (name === "NotFoundError") return "DESTINATION_UNAVAILABLE";
  return (
    {
      write: "WRITE_FAILED",
      close: "CLOSE_FAILED",
      "location-check": "LOCATION_CHECK_FAILED",
      download: "DOWNLOAD_REQUEST_FAILED",
    }[phase] || "UNKNOWN"
  );
}
function browserInfo(ua = "") {
  for (const [name, pattern] of [
    ["Edge", /Edg\/(\d{1,3})/],
    ["Firefox", /Firefox\/(\d{1,3})/],
    ["Chrome", /Chrome\/(\d{1,3})/],
    ["Safari", /Version\/(\d{1,3})/],
  ]) {
    const match = pattern.exec(ua);
    if (match) return { name, majorVersion: match[1] };
  }
  return { name: "Other", majorVersion: "unknown" };
}
export function createOperationLogger({
  window,
  config,
  appVersion,
  now = () => Date.now(),
}) {
  let endpoint = "";
  try {
    const url = new URL(config.endpoint);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/v1/operations" &&
      window.location?.origin === "https://lucky2449.github.io" &&
      typeof window.fetch === "function"
    )
      endpoint = url.href;
  } catch {}
  const configured = Boolean(endpoint);
  let consent = false;
  let generation = 0;
  const controllers = new Set();
  let sessionId;
  const browser = browserInfo(window.navigator?.userAgent);
  let pending = 0;
  // No persistent queue: never retain a user's work history on disk.
  function send(value, operationGeneration) {
    if (
      !configured ||
      !consent ||
      operationGeneration !== generation ||
      pending >= 8
    )
      return;
    try {
      validateOperation(value);
      const body = JSON.stringify(value);
      if (new TextEncoder().encode(body).length > 4096) return;
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 5000);
      pending++;
      Promise.resolve()
        .then(() => {
          if (
            !consent ||
            operationGeneration !== generation ||
            controller.signal.aborted
          )
            return;
          return window.fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            credentials: "omit",
            referrerPolicy: "no-referrer",
            keepalive: true,
            signal: controller.signal,
          });
        })
        .catch(() => {})
        .finally(() => {
          pending--;
          controllers.delete(controller);
          clearTimeout(timer);
        });
    } catch {}
  }
  function begin(mode, { selectedCount = 0, selectedBytes = 0 } = {}) {
    if (!configured || !consent) return { error() {}, finish() {} };
    const operationGeneration = generation;
    let operationId;
    try {
      sessionId ||= window.crypto.randomUUID();
      operationId = window.crypto.randomUUID();
    } catch {}
    const start = now();
    let finished = false;
    const errors = new Map();
    const base = {
      schemaVersion: 1,
      sessionId,
      operationId,
      appVersion,
      buildId: config.buildId,
      browser,
      mode,
    };
    const zero = {
      selected: selectedCount,
      succeeded: 0,
      requested: 0,
      archived: 0,
      failed: 0,
      unprocessed: selectedCount,
    };
    if (mode !== "visit")
      send(
        {
          ...base,
          sequence: 1,
          clientTime: new Date(start).toISOString(),
          stage: "started",
          result: "started",
          durationMs: 0,
          files: zero,
          bytes: { selected: selectedBytes, written: 0, prepared: 0 },
          errors: [],
        },
        operationGeneration,
      );
    return {
      error(error, phase) {
        if (!consent || operationGeneration !== generation) return;
        if (error?.name === "AbortError" || !PHASES.has(phase)) return;
        const code = classifyOperationError(error, phase),
          key = code + ":" + phase;
        const item = errors.get(key);
        if (item) item.count++;
        else if (errors.size < 30) errors.set(key, { code, phase, count: 1 });
      },
      finish({
        result,
        succeeded = 0,
        requested = 0,
        archived = 0,
        failed = 0,
        writtenBytes = 0,
        preparedBytes = 0,
      } = {}) {
        if (finished || !consent || operationGeneration !== generation) return;
        finished = true;
        send(
          {
            ...base,
            sequence: 2,
            clientTime: new Date(now()).toISOString(),
            stage: "finished",
            result,
            durationMs: Math.max(0, now() - start),
            files: {
              ...zero,
              succeeded,
              requested,
              archived,
              failed,
              unprocessed: selectedCount - succeeded - requested - failed,
            },
            bytes: {
              selected: selectedBytes,
              written: writtenBytes,
              prepared: preparedBytes,
            },
            errors: [...errors.values()],
          },
          operationGeneration,
        );
      },
    };
  }
  return {
    configured,
    get enabled() {
      return configured && consent;
    },
    setConsent(value) {
      const next = value === true;
      if (next === consent) return;
      consent = next;
      generation++;
      if (!consent) {
        sessionId = undefined;
        for (const controller of controllers) controller.abort();
      }
    },
    begin,
    visit() {
      const op = begin("visit");
      op.finish({ result: "visited" });
    },
  };
}
