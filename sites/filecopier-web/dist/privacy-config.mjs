// Public policy facts only. Never add account credentials here.
// Verify provider settings and change policyVersion before enabling collection.
export const privacyConfig = Object.freeze({
  policyVersion: "2026-10-20.2",
  operatorName: "파일모아 운영자",
  contactEmail: "sjm2449@naver.com",
  consentDays: 180,
  analytics: {
    recipient: "Google LLC",
    contact: "https://support.google.com/policies/troubleshooter/7575787?hl=ko",
    countries: [],
    processingScope: "Google・하위 처리업체의 글로벌 시설에서 처리 가능. 실제 저장·접근 국가 미확인",
    retentionMonths: 2,
    verified: false,
    collectionEnabled: true,
  },
  logs: {
    recipient: "Cloudflare, Inc.",
    contact: "https://www.cloudflare.com/privacypolicy/",
    countries: [],
    processingScope: "D1 실행 지역 APAC, 국가 제한 없음. 정확한 저장·백업 국가와 Worker·통신 메타데이터 처리 국가 미확인",
    retentionDays: 90,
    verified: false,
    collectionEnabled: true,
  },
});
