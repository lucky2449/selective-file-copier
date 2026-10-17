import { writeZip } from "./zip.mjs";
import {
  zipSize,
  DOWNLOAD_ZIP_LIMIT,
} from "./zip-storage.mjs?v=stream-zip-4gb-1";
const TEMP_DIRECTORY = "filemoa-zip-downloads-v1";
const TEMP_NAME = /^zip-(\d{13})-[0-9a-f-]{36}\.tmp$/;
// Only our private temporary ZIP files older than seven days may be pruned.
export async function pruneZipTemps(directory, now = Date.now()) {
  for await (const entry of directory.values()) {
    const match = TEMP_NAME.exec(entry.name);
    if (entry.kind === "file" && match && now - Number(match[1]) > 7 * 86400000)
      await directory.removeEntry(entry.name).catch(() => {});
  }
}
export async function prepareZipDownload(
  entries,
  { storage, cancelled = () => false, progress = () => {} } = {},
) {
  const native = typeof storage?.getDirectory === "function";
  const expected = zipSize(entries, native ? undefined : DOWNLOAD_ZIP_LIMIT);
  const check = () => {
    if (cancelled()) throw new DOMException("작업 취소", "AbortError");
  };
  check();
  if (!native) {
    const parts = [];
    let bytes = 0;
    await writeZip(
      entries,
      {
        write: async (chunk) => {
          check();
          bytes += chunk.byteLength;
          if (bytes > expected)
            throw new Error("원본 크기가 달라 ZIP 생성을 중단했습니다.");
          parts.push(chunk);
        },
      },
      { cancelled, progress },
    );
    check();
    if (bytes !== expected)
      throw new Error("원본 크기가 달라 ZIP 생성을 중단했습니다.");
    return new Blob(parts, { type: "application/zip" });
  }
  if (typeof storage.estimate === "function") {
    const { quota, usage } = await storage.estimate();
    if (
      Number.isFinite(quota) &&
      Number.isFinite(usage) &&
      quota - usage < expected
    )
      throw new DOMException(
        "브라우저 임시 저장 공간이 부족합니다. 파일을 나눠 선택하세요.",
        "QuotaExceededError",
      );
  }
  check();
  const root = await storage.getDirectory();
  const directory = await root.getDirectoryHandle(TEMP_DIRECTORY, {
    create: true,
  });
  await pruneZipTemps(directory);
  check();
  const name = `zip-${Date.now()}-${crypto.randomUUID()}.tmp`;
  // UUID is per operation. Never open or overwrite an observed existing entry.
  try {
    await directory.getFileHandle(name);
    throw new Error("임시 파일 충돌로 ZIP 생성을 중단했습니다.");
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
  }
  let writer;
  try {
    const handle = await directory.getFileHandle(name, { create: true });
    writer = await handle.createWritable();
    let bytes = 0;
    await writeZip(
      entries,
      {
        write: async (chunk) => {
          check();
          if (bytes + chunk.byteLength > expected)
            throw new Error("원본 크기가 달라 ZIP 생성을 중단했습니다.");
          await writer.write(chunk);
          bytes += chunk.byteLength;
        },
      },
      { cancelled, progress },
    );
    check();
    if (bytes !== expected)
      throw new Error("원본 크기가 달라 ZIP 생성을 중단했습니다.");
    await writer.close();
    writer = null;
    check();
    const file = await handle.getFile();
    if (file.size !== expected)
      throw new Error("ZIP 임시 파일 크기를 확인하지 못했습니다.");
    // Keep the backing file intact: browser download completion is not observable.
    // Later ZIP creation prunes only our private files older than seven days.
    return file;
  } catch (error) {
    if (writer) await writer.abort().catch(() => {});
    await directory.removeEntry(name).catch(() => {});
    throw error;
  }
}
