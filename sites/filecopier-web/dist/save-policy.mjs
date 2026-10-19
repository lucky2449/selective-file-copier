export const APP_VERSION = "2026.10.19-logs-8";
export const NOTICE_VERSION = "1";
export function createSaveNotice(env) {
  let accepted = false;
  return () => {
    try {
      accepted ||=
        env.localStorage?.getItem("filemoa-save-notice") === NOTICE_VERSION;
    } catch {}
    if (accepted) return true;
    if (
      !env.confirm(
        "저장 전 확인\n\n파일모아는 원본을 읽어 복사본을 만드는 도구이며, 원본 수정·삭제·이동 기능을 제공하지 않습니다.\n\n중요한 사진은 별도 백업을 권장합니다. 저장 후 파일 수와 열림 여부를 확인하고, 확인 전에는 원본을 삭제하지 마세요.\n\n확인을 누르면 안내에 동의하고 저장을 시작합니다.",
      )
    )
      return false;
    accepted = true;
    try {
      env.localStorage?.setItem("filemoa-save-notice", NOTICE_VERSION);
    } catch {}
    return true;
  };
}
export function createDiagnostics(userAgent = "") {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Other";
  const entries = [];
  const modes = new Set(["copy", "download", "zip"]);
  const stages = new Set([
    "started",
    "location-check",
    "writing",
    "completed",
    "requested",
    "failed",
    "cancelled",
  ]);
  return {
    record(mode, stage) {
      if (!modes.has(mode) || !stages.has(stage)) return;
      entries.push({ time: new Date().toISOString(), mode, stage });
      if (entries.length > 200) entries.shift();
    },
    export() {
      return JSON.stringify(
        {
          appVersion: APP_VERSION,
          noticeVersion: NOTICE_VERSION,
          browser,
          entries,
        },
        null,
        2,
      );
    },
  };
}
