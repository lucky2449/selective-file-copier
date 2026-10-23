import { MAX_REVIEW_JPEG_BYTES } from "./portrait-analysis.mjs?v=portrait-spatial-detail-13";
export function createPortraitReviewer(window) {
  let current, worker;
  const cache = new Map();
  let cacheBytes = 0,
    cacheGeneration = 0;
  const clearCache = () => {
    cache.clear();
    cacheBytes = 0;
    cacheGeneration++;
  };
  const putCache = (key, result) => {
    if (!key) return;
    const json = JSON.stringify(result);
    const bytes = json.length * 2;
    if (bytes > 16 * 1024 * 1024) return;
    while (cache.size >= 128 || cacheBytes + bytes > 16 * 1024 * 1024) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
    cache.set(key, { json, bytes });
    cacheBytes += bytes;
  };
  const reset = () => {
    worker?.terminate();
    worker = null;
  };
  return {
    cancel() {
      current?.();
    },
    clearCache,
    dispose() {
      current?.();
      reset();
      clearCache();
    },
    analyze(file, { signal, profile, motionProfile } = {}) {
      if (signal?.aborted)
        return Promise.reject(new DOMException("Cancelled", "AbortError"));
      if (
        !file ||
        !Number.isSafeInteger(file.size) ||
        file.size <= 0 ||
        file.size > MAX_REVIEW_JPEG_BYTES
      )
        return Promise.reject(new RangeError("JPEG file limit"));
      if (current || typeof window.Worker !== "function")
        return Promise.reject(new Error("Photo reviewer unavailable"));
      return new Promise((resolve, reject) => {
        let timer, cacheKey;
        const generation = cacheGeneration;
        const finish = (error, result) => {
          if (current !== cancel) return;
          current = null;
          window.clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          if (error) reset();
          if (!error && generation === cacheGeneration) {
            try {
              putCache(cacheKey, result);
            } catch {
              /* Cache is optional. */
            }
          }
          error ? reject(error) : resolve(result);
        };
        const cancel = () =>
          finish(new DOMException("Cancelled", "AbortError"));
        current = cancel;
        const start = async () => {
          try {
            // Hash bytes rather than names/size/mtime: a reselected File has a new identity.
            const savedProfile =
              profile == null ? profile : structuredClone(profile);
            const savedMotionProfile =
              motionProfile == null
                ? motionProfile
                : structuredClone(motionProfile);
            const profileKey = JSON.stringify({
              profile: savedProfile,
              motionProfile: savedMotionProfile,
            });
            if (
              typeof file.arrayBuffer === "function" &&
              window.crypto?.subtle
            ) {
              const digest = await window.crypto.subtle.digest(
                "SHA-256",
                await file.arrayBuffer(),
              );
              if (current !== cancel) return;
              cacheKey =
                "native-face-eyes-v1:face-spatial-detail-13:" +
                Array.from(new Uint8Array(digest), (b) =>
                  b.toString(16).padStart(2, "0"),
                ).join("") +
                ":" +
                profileKey;
              const hit = cache.get(cacheKey);
              if (hit) {
                cache.delete(cacheKey);
                cache.set(cacheKey, hit);
                // Do not add this entry a second time in finish().
                cacheKey = null;
                finish(null, JSON.parse(hit.json));
                return;
              }
            }
            if (current !== cancel) return;
            worker ??= new window.Worker(
              new URL(
                "./portrait-review-worker.mjs?v=portrait-spatial-detail-13",
                import.meta.url,
              ),
              { type: "module" },
            );
            worker.onmessage = ({ data }) => {
              if (data?.error) finish(new Error(data.error));
              else if (data?.result?.algorithmVersion === "native-face-eyes-v1")
                finish(null, data.result);
              else finish(new Error("Invalid photo review response"));
            };
            worker.onerror = () =>
              finish(new Error("Photo review worker unavailable"));
            worker.onmessageerror = () =>
              finish(new Error("Photo review response unavailable"));
            worker.postMessage({
              file,
              profile: savedProfile,
              motionProfile: savedMotionProfile,
            });
          } catch (error) {
            finish(error);
          }
        };
        signal?.addEventListener("abort", cancel, { once: true });
        timer = window.setTimeout(
          () => finish(new Error("Photo review timeout")),
          30000,
        );
        void start();
      });
    },
  };
}



