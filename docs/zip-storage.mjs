import {
  assertDistinctDirectories,
  createResultDirectory,
} from "./directory-access.mjs?v=short-time-name-1";
import { openCopyWriter } from "./copy-safety.mjs?v=source-protection-2";
import { withCopyLock } from "./copy-lock.mjs?v=copy-lock-1";
import { writeZip } from "./zip.mjs";

export const DISK_ZIP_LIMIT = 2 * 1024 * 1024 * 1024;
export const DOWNLOAD_ZIP_LIMIT = 512 * 1024 * 1024;
// Stored ZIP: local header + descriptor + central header + two UTF-8 names.
export function zipSize(entries, limit = DISK_ZIP_LIMIT) {
  if (entries.length > 65535)
    throw new Error("ZIP 한 개에는 최대 65,535개 파일을 저장할 수 있습니다.");
  let total = 22;
  for (const { name, file } of entries) {
    const length = new TextEncoder().encode(name).length;
    if (length > 65535 || !Number.isSafeInteger(file.size) || file.size < 0)
      throw new Error("ZIP 파일 이름 또는 크기를 확인할 수 없습니다.");
    total += file.size + 92 + length * 2;
    if (total > limit)
      throw new Error(
        limit === DISK_ZIP_LIMIT
          ? "ZIP은 파일 이름 등 부가 정보를 포함해 최대 2GB까지 저장할 수 있습니다. 파일을 나눠 선택하세요."
          : "이 브라우저의 일반 ZIP 다운로드는 512MB까지 지원합니다. 대용량 ZIP은 폴더 저장을 지원하는 브라우저에서 사용하세요.",
      );
  }
  return total;
}
export async function saveZipToDirectory(
  entries,
  {
    destination,
    source = null,
    locks,
    signal,
    cancelled = () => false,
    progress = () => {},
    onWaiting = () => {},
    onDirectory = () => {},
  } = {},
) {
  const expected = zipSize(entries);
  const stopped = () => cancelled() || signal?.aborted;
  const check = () => {
    if (stopped()) throw new DOMException("작업 취소", "AbortError");
  };
  return withCopyLock(
    async () => {
      check();
      if (source) await assertDistinctDirectories(source, destination);
      const folder = await createResultDirectory(destination, {
        cancelled: stopped,
      });
      if (source) await assertDistinctDirectories(source, folder);
      check();
      const name = "파일모아.zip";
      // Fail on any observed collision, including an empty file.
      try {
        await folder.getFileHandle(name);
        throw new Error("기존 ZIP 파일이 감지되어 저장을 중단했습니다.");
      } catch (error) {
        if (error.name !== "NotFoundError") throw error;
      }
      onDirectory(`${destination.name}/${folder.name}/${name}`);
      let writer;
      try {
        writer = await openCopyWriter(folder, name, {
          source,
          cancelled: stopped,
        });
        let bytes = 0;
        await writeZip(
          entries,
          {
            async write(chunk) {
              check();
              if (bytes + chunk.byteLength > DISK_ZIP_LIMIT)
                throw new Error(
                  "ZIP 크기가 2GB를 초과하여 저장을 중단했습니다.",
                );
              await writer.write(chunk);
              bytes += chunk.byteLength;
            },
          },
          { cancelled: stopped, progress },
        );
        check();
        if (bytes !== expected)
          throw new Error(
            "원본 파일 크기가 달라져 ZIP 저장을 중단했습니다. 원본을 다시 선택하세요.",
          );
        await writer.close();
        return { folder: folder.name, name, bytes };
      } catch (error) {
        // Keep the shared copy lock until abort finishes. Never remove files.
        if (writer) await writer.abort().catch(() => {});
        throw error;
      }
    },
    { locks, signal, onWaiting },
  );
}
