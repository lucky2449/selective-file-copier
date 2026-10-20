export const RAW_CONVERT_LIMIT = 64 * 1024 * 1024;
export const RAW_PIXEL_LIMIT = 50_000_000;
export const RAW_CONVERT_TIMEOUT = 20_000;

// One disposable worker at a time; files are cloned locally, never uploaded.
export function createRawConverter(window) {
  let current;
  return {
    cancel() {
      current?.();
    },
    convert(file, { signal } = {}) {
      if (signal?.aborted)
        return Promise.reject(new DOMException("Cancelled", "AbortError"));
      if (!file || file.size > RAW_CONVERT_LIMIT || file.size <= 0)
        return Promise.reject(new Error("RAW preview limit"));
      if (current || typeof window.Worker !== "function")
        return Promise.reject(new Error("RAW preview unavailable"));
      return new Promise((resolve, reject) => {
        let worker, timer;
        const finish = (error, blob) => {
          if (current !== abort) return;
          current = null;
          window.clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          worker?.terminate();
          error ? reject(error) : resolve(blob);
        };
        const abort = () => finish(new DOMException("Cancelled", "AbortError"));
        current = abort;
        try {
          worker = new window.Worker(
            new URL("./raw-convert-worker.mjs", import.meta.url),
            { type: "module" },
          );
          worker.onmessage = ({ data }) => {
            if (
              data?.blob instanceof Blob &&
              data.blob.type === "image/jpeg" &&
              data.blob.size > 0 &&
              data.blob.size < 1024 * 1024
            )
              finish(null, data.blob);
            else finish(new Error("RAW preview unavailable"));
          };
          worker.onerror = () => finish(new Error("RAW preview unavailable"));
          worker.onmessageerror = () =>
            finish(new Error("RAW preview unavailable"));
          signal?.addEventListener("abort", abort, { once: true });
          timer = window.setTimeout(
            () => finish(new Error("RAW preview timeout")),
            RAW_CONVERT_TIMEOUT,
          );
          worker.postMessage({ file });
        } catch (error) {
          finish(error);
        }
      });
    },
  };
}
