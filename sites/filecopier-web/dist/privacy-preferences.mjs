export const PRIVACY_STORAGE_KEY = "filemoa-privacy-preferences";
export const PRIVACY_NOTICE_VERSION = "2026-10-22-1";

export function parsePrivacyPreferences(text) {
  try {
    const value = JSON.parse(text);
    if (
      value?.schemaVersion !== 1 ||
      typeof value.analytics !== "boolean" ||
      typeof value.operationLogs !== "boolean" ||
      typeof value.noticeVersion !== "string" ||
      typeof value.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.updatedAt))
    )
      return null;
    return {
      schemaVersion: 1,
      noticeVersion: value.noticeVersion,
      updatedAt: value.updatedAt,
      analytics: value.analytics,
      operationLogs: value.operationLogs,
    };
  } catch {
    return null;
  }
}

export function createPrivacyPreferences({
  window,
  document,
  onChange,
  now = () => new Date(),
}) {
  const get = (id) => document.getElementById(id);
  const dialog = get("privacy-dialog");
  const analytics = get("privacy-analytics");
  const logs = get("privacy-operation-logs");
  const trigger = get("privacy-settings");
  const closeButton = get("privacy-close");
  const status = get("privacy-status");
  let stored = null;
  let returnFocus = null;
  try {
    stored = parsePrivacyPreferences(
      window.localStorage?.getItem(PRIVACY_STORAGE_KEY),
    );
  } catch {}

  function apply() {
    // Unanswered, deleted or malformed preferences always fail closed.
    try {
      onChange({
        analytics: stored?.analytics === true,
        operationLogs: stored?.operationLogs === true,
      });
    } catch {}
  }
  function close() {
    if (typeof dialog.close === "function") dialog.close();
    else {
      dialog.open = false;
      dialog.hidden = true;
    }
    returnFocus?.focus?.();
  }
  function open() {
    if (dialog.open) return;
    returnFocus = document.activeElement;
    analytics.checked = stored?.analytics === true;
    logs.checked = stored?.operationLogs === true;
    closeButton.setAttribute(
      "aria-label",
      stored ? "변경하지 않고 닫기" : "거절하고 닫기",
    );
    if (typeof dialog.showModal === "function") dialog.showModal();
    else {
      dialog.hidden = false;
      dialog.open = true;
    }
  }
  function save(allow) {
    stored = {
      schemaVersion: 1,
      noticeVersion: PRIVACY_NOTICE_VERSION,
      updatedAt: now().toISOString(),
      analytics: allow && analytics.checked === true,
      operationLogs: allow && logs.checked === true,
    };
    let remembered = false;
    try {
      const storage = window.localStorage;
      if (storage) {
        const text = JSON.stringify(stored);
        storage.setItem(PRIVACY_STORAGE_KEY, text);
        remembered = storage.getItem(PRIVACY_STORAGE_KEY) === text;
      }
    } catch {}
    status.textContent = remembered
      ? "개인정보 설정을 저장했습니다."
      : "이 브라우저에 선택을 저장하지 못했습니다. 다시 접속하면 설정창이 표시될 수 있습니다.";
    apply();
    close();
  }
  function dismiss() {
    if (!stored) save(false);
    else close(); // Closing an explicitly reopened dialog cancels edits.
  }
  trigger.addEventListener("click", open);
  closeButton.addEventListener("click", dismiss);
  get("privacy-reject").addEventListener("click", () => save(false));
  get("privacy-allow").addEventListener("click", () => save(true));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  // Synchronize withdrawals across tabs without re-opening a dialog.
  window.addEventListener?.("storage", (event) => {
    if (event.key !== PRIVACY_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage)
        return;
    } catch {
      return;
    }
    stored =
      event.key === null ? null : parsePrivacyPreferences(event.newValue);
    analytics.checked = stored?.analytics === true;
    logs.checked = stored?.operationLogs === true;
    apply();
    if (dialog.open) close();
    status.textContent = "다른 탭의 개인정보 설정을 반영했습니다.";
  });
  apply();
  if (!stored) open();
  return { open };
}
