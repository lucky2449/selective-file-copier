// Public policy facts only. Never add account credentials here.
// Verify provider settings and change policyVersion before enabling collection.
export const privacyConfig = Object.freeze({
  policyVersion: "2026-10-20.1",
  operatorName: "파일모아 운영자",
  contactEmail: "sjm2449@naver.com",
  consentDays: 180,
  analytics: {
    recipient: "Google LLC",
    contact: "https://support.google.com/policies/troubleshooter/7575787?hl=ko",
    countries: [],
    retentionMonths: null,
    verified: false,
  },
  logs: {
    recipient: "Cloudflare, Inc.",
    contact: "https://www.cloudflare.com/privacypolicy/",
    countries: [],
    retentionDays: 90,
    verified: false,
  },
});
