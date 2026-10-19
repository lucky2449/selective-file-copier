// Public endpoint only. Never put API keys or account credentials in frontend code.
// Empty endpoint disables ALL operation-log requests and its separate notice.
export const operationLogConfig = Object.freeze({
  endpoint: "",
  buildId: "unversioned",
  retentionDays: 90,
});
