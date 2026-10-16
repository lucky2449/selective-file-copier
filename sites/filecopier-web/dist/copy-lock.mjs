// A single stable lock serializes directory copies across this site's tabs.
// Destination display names are not reliable filesystem identities.
export const COPY_LOCK_NAME = "filemoa-directory-copy-v1";

export async function withCopyLock(
  task,
  {
    locks = globalThis.navigator?.locks,
    signal,
    onWaiting = () => {},
    onAcquired = () => {},
  } = {},
) {
  if (signal?.aborted)
    throw new DOMException("작업을 취소했습니다.", "AbortError");
  if (typeof locks?.request !== "function") {
    throw new Error(
      "이 브라우저에서는 탭 간 복사 잠금을 사용할 수 없습니다. 지원 브라우저에서 다시 시도하거나 일반 다운로드를 사용하세요.",
    );
  }
  let acquired = false;
  onWaiting();
  try {
    return await locks.request(
      COPY_LOCK_NAME,
      {
        mode: "exclusive",
        ...(signal ? { signal } : {}),
      },
      async (lock) => {
        if (!lock) throw new Error("폴더 복사 잠금을 확보하지 못했습니다.");
        if (signal?.aborted)
          throw new DOMException("작업을 취소했습니다.", "AbortError");
        acquired = true;
        onAcquired();
        // Returning this promise retains the lock through writes and cleanup.
        return await task();
      },
    );
  } catch (error) {
    if (!acquired && error.name !== "AbortError") {
      throw new Error(
        "탭 간 복사 잠금을 확보하지 못해 복사를 시작하지 않았습니다. 일반 다운로드를 사용하거나 사이트를 다시 열어 주세요.",
        { cause: error },
      );
    }
    throw error;
  }
}
