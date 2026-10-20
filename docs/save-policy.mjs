export const APP_VERSION = "2026.10.20-preview-15";
export const NOTICE_VERSION = "2";
export function createSaveNotice(
  env,
  { operationLogsEnabled = false, retentionDays = 90 } = {},
) {
  const acceptanceVersion = `${NOTICE_VERSION}:${operationLogsEnabled ? `logs-${retentionDays}` : "local"}`;
  const logNotice = operationLogsEnabled
    ? `\n\n접속 시부터 오류 분석·분쟁 대응용 작업 기록을 Cloudflare 서버로 전송하며, ${retentionDays}일 기준으로 보관·정리합니다.`
    : "";
  let accepted = false;
  return () => {
    try {
      accepted ||=
        env.localStorage?.getItem("filemoa-save-notice") === acceptanceVersion;
    } catch {}
    if (accepted) return true;
    if (
      !env.confirm(
        "저장 전 확인\n\n원본 수정·삭제·이동 기능은 없습니다. 중요한 파일은 백업하고, 복사 결과 확인 전 원본을 삭제하지 마세요.\n\n파일 내용·이름·경로·입력 목록은 서버로 보내지 않습니다." +
          logNotice +
          "\n\n확인을 누르면 저장을 시작합니다.",
      )
    )
      return false;
    accepted = true;
    try {
      env.localStorage?.setItem("filemoa-save-notice", acceptanceVersion);
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
