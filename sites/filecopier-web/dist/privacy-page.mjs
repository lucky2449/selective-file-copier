import { privacyConfig as config } from "./privacy-config.mjs?v=privacy-3";
import { privacyReady } from "./privacy.mjs?v=privacy-3";
const set = (id, text) => {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
};
set("policy-version", config.policyVersion);
set("policy-operator", config.operatorName);
set("policy-email", config.contactEmail);
document.getElementById("policy-email").href = "mailto:" + config.contactEmail;
for (const kind of ["analytics", "logs"]) {
  const ready = privacyReady(config, kind),
    provider = config[kind];
  set(
    "policy-" + kind + "-status",
    ready
      ? "별도 선택 동의 후 전송 (국가 범위 확인 중)"
      : "설정 확인 전 신규 전송 중지",
  );
  set(
    "policy-" + kind + "-countries",
    provider.countries.length
      ? provider.countries.join(", ")
      : provider.processingScope || "미확인 — 신규 전송 중지",
  );
}
set(
  "policy-ga-retention",
  config.analytics.retentionMonths
    ? `사용자·이벤트 수준 데이터 ${config.analytics.retentionMonths}개월 (합산 보고서의 보관과는 별도)`
    : "GA4 관리 설정 미확인 — 확인 전 신규 전송하지 않습니다. 기존 자료의 보유 설정도 확인 중입니다.",
);
