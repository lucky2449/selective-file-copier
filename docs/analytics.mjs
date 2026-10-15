// Only fixed event names, validated file counts and fixed page metadata may reach GA4.
// File objects, names, paths, search text, errors and URL queries are never accepted.
const PAGE = "https://lucky2449.github.io/selective-file-copier/";
const EVENTS = new Set([
  "page_view",
  "file_search",
  "copy_success",
  "copy_failure",
  "download_request",
  "zip_created",
]);

export function createAnalytics({ measurementId = "", window, document }) {
  let active = false;
  let started = false;
  let visited = false;
  const configured =
    /^G-[A-Z0-9]+$/.test(measurementId) &&
    window?.location?.origin === "https://lucky2449.github.io";
  const metadata = {
    page_location: PAGE,
    page_title: "파일모아",
    page_referrer: "",
  };
  const gtag = function () {
    window.dataLayer.push(arguments);
  };
  return {
    configured,
    start() {
      if (!configured || started) return;
      started = true;
      try {
        window.dataLayer = window.dataLayer || [];
        window.gtag = gtag;
        gtag("consent", "default", {
          analytics_storage: "granted",
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
        });
        gtag("js", new Date());
        gtag("config", measurementId, {
          send_page_view: false,
          allow_google_signals: false,
          allow_ad_personalization_signals: false,
          ...metadata,
        });
        const script = document.createElement("script");
        script.async = true;
        script.referrerPolicy = "no-referrer";
        script.src =
          "https://www.googletagmanager.com/gtag/js?id=" + measurementId;
        script.onerror = () => {
          active = false;
        };
        document.head.append(script);
        active = true;
        this.track("page_view");
      } catch {
        active = false; // Analytics must never block searching or copying.
      }
    },
    recordCopyResult(success, failed) {
      this.track("copy_success", success);
      this.track("copy_failure", failed);
    },
    track(event, count) {
      if (!active || !EVENTS.has(event)) return;
      if (event === "page_view" && visited) return;
      const counts = {};
      if (event === "copy_success" || event === "copy_failure") {
        if (!Number.isSafeInteger(count) || count <= 0) return;
        counts[
          event === "copy_success" ? "copied_file_count" : "failed_file_count"
        ] = count;
      }
      try {
        gtag("event", event, {
          send_to: measurementId,
          ...metadata,
          ...counts,
        });
        if (event === "page_view") visited = true;
      } catch {
        // Do not log user data or interrupt a file operation for analytics errors.
      }
    },
  };
}
