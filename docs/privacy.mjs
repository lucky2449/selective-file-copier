export const PRIVACY_KEY = "filemoa-privacy-v1";
const fields = ["analyticsUse", "analyticsTransfer", "logsUse", "logsTransfer"];
const empty = () => Object.fromEntries(fields.map((key) => [key, false]));
export function privacyReady(config, kind) {
  const provider = config?.[kind];
  return Boolean(
    config?.contactEmail &&
      config?.operatorName &&
      provider?.verified === true &&
      provider.recipient &&
      provider.contact &&
      Array.isArray(provider.countries) &&
      provider.countries.length &&
      provider.countries.every(
        (country) => typeof country === "string" && country.trim(),
      ) &&
      Number.isInteger(
        kind === "analytics"
          ? provider.retentionMonths
          : provider.retentionDays,
      ) &&
      (kind === "analytics"
        ? provider.retentionMonths
        : provider.retentionDays) > 0,
  );
}
export function createPrivacy({ window, config, now = () => Date.now() }) {
  const scope = JSON.stringify(config);
  let record = null,
    revision = 0;
  const listeners = new Set();
  function valid(value) {
    return (
      value?.version === config.policyVersion &&
      value.scope === scope &&
      Number.isFinite(value.at) &&
      value.at <= now() + 300000 &&
      value.expires === value.at + config.consentDays * 86400000 &&
      value.expires > now() &&
      fields.every((key) => typeof value.choices?.[key] === "boolean")
    );
  }
  try {
    const stored = JSON.parse(
      window.localStorage?.getItem(PRIVACY_KEY) ?? "null",
    );
    if (valid(stored)) record = stored;
  } catch {}
  const allowed = (kind) =>
    Boolean(
      record &&
        valid(record) &&
        privacyReady(config, kind) &&
        record.choices[kind + "Use"] &&
        record.choices[kind + "Transfer"],
    );
  const notify = () => {
    revision++;
    for (const fn of listeners) fn();
  };
  let expiryTimer;
  function scheduleExpiry() {
    window.clearTimeout?.(expiryTimer);
    if (!record || typeof window.setTimeout !== "function") return;
    expiryTimer = window.setTimeout(
      () => {
        if (record && !valid(record)) {
          record = null;
          notify();
        }
        scheduleExpiry();
      },
      Math.max(1, Math.min(record.expires - now(), 2147483647)),
    );
  }
  scheduleExpiry();
  window.addEventListener?.("storage", (event) => {
    if (event.key !== PRIVACY_KEY && event.key !== null) return;
    try {
      const value = JSON.parse(event.newValue ?? "null");
      record = valid(value) ? value : null;
    } catch {
      record = null;
    }
    notify();
    scheduleExpiry();
  });
  return {
    allowed,
    get revision() {
      return revision;
    },
    get decided() {
      return Boolean(record && valid(record));
    },
    get choices() {
      return record && valid(record) ? { ...record.choices } : empty();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    save(choices) {
      const safe = empty();
      for (const kind of ["analytics", "logs"])
        if (privacyReady(config, kind)) {
          safe[kind + "Use"] = choices?.[kind + "Use"] === true;
          safe[kind + "Transfer"] = choices?.[kind + "Transfer"] === true;
        }
      const at = now();
      record = {
        version: config.policyVersion,
        scope,
        at,
        expires: at + config.consentDays * 86400000,
        choices: safe,
      };
      try {
        window.localStorage?.setItem(PRIVACY_KEY, JSON.stringify(record));
      } catch {}
      notify();
      scheduleExpiry();
    },
  };
}

export function bindPrivacy({
  window,
  document,
  config,
  privacy,
  changed = () => {},
}) {
  const get = (id) => document.getElementById(id);
  const panel = get("privacy-panel");
  if (!panel) {
    changed();
    return;
  }
  function refresh() {
    if (!privacy.decided) panel.hidden = false;
    for (const key of fields) {
      get("privacy-" + key).checked = privacy.choices[key];
      get("privacy-" + key).disabled = !privacyReady(
        config,
        key.startsWith("analytics") ? "analytics" : "logs",
      );
    }
    get("privacy-status").textContent =
      `GA4 통계 ${privacy.allowed("analytics") ? "허용" : "꺼짐"} · 작업 기록 ${privacy.allowed("logs") ? "허용" : "꺼짐"}`;
    for (const [kind, label] of [
      ["analytics", "GA4 보관기간·국외 처리 국가"],
      ["logs", "로그 저장 국가·국외 처리 범위"],
    ])
      get("privacy-" + kind + "-status").textContent = privacyReady(
        config,
        kind,
      )
        ? `이전 국가: ${config[kind].countries.join(", ")} · 보유: ${kind === "analytics" ? config.analytics.retentionMonths + "개월" : config.logs.retentionDays + "일 정리 기준"} · 동의 후 이용 시 HTTPS 전송`
        : `${label} 확인 전에는 전송하지 않습니다.`;
    changed();
  }
  privacy.subscribe(refresh);
  refresh();
  panel.hidden = privacy.decided;
  get("privacy-settings").addEventListener("click", () => {
    panel.hidden = false;
    const details = get("privacy-options");
    if (details) details.open = true;
    refresh();
  });
  get("privacy-reject").addEventListener("click", () => {
    privacy.save(empty());
    panel.hidden = true;
  });
  get("privacy-save").addEventListener("click", () => {
    const choices = Object.fromEntries(
      fields.map((key) => [key, get("privacy-" + key).checked]),
    );
    privacy.save(choices);
    panel.hidden = true;
  });
}
