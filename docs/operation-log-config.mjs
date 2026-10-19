// Public endpoint only. Never put API keys or account credentials in frontend code.
// Empty endpoint disables ALL operation-log requests and its separate notice.
export const operationLogConfig = Object.freeze({
  endpoint: "https://filemoa-operation-logs.lucky2449-filemoa.workers.dev/v1/operations",
  buildId: "unversioned",
  retentionDays: 90,
});
