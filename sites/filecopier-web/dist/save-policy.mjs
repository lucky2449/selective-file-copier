export const APP_VERSION = "2026.10.19-notice-9";
export const NOTICE_VERSION = "2";
export function createSaveNotice(
  env,
  { operationLogsEnabled = false, retentionDays = 90 } = {},
) {
  const acceptanceVersion = `${NOTICE_VERSION}:${operationLogsEnabled ? `logs-${retentionDays}` : "local"}`;
  const logNotice = operationLogsEnabled
    ? `\n\n오류 분석·분쟁 대응을 위해 접속 시부터 임시 작업 ID, 작업 결과, 처리 수량·용량, 오류 코드, 앱·브라우저 버전 및 시각을 Cloudflare 기반 운영자 로그 서버로 전송합니다. 기록은 ${retentionDays}일을 기준으로 보관 후 순차 정리합니다. 일반 다운로드·ZIP은 실제 저장 완료가 아닌 다운로드 요청을 기록합니다.`
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
        "저장 전 확인\n\n파일모아는 원본을 읽어 복사본을 만드는 도구이며, 원본 수정·삭제·이동 기능을 제공하지 않습니다.\n\n중요한 사진은 별도로 백업하세요. 저장 후 파일 수와 열림 여부를 확인하고, 확인 전에는 원본을 삭제하지 마세요.\n\n파일 내용·파일명·폴더 경로·입력 목록은 서버로 전송하지 않습니다." +
          logNotice +
          "\n\n확인을 누르면 위 안내를 확인하고 저장을 시작합니다.",
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
