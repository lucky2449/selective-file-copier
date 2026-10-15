// Only output handles may be opened for writing. Never delete on failure.
// Browser APIs do not provide atomic create-if-absent; isolate outputs and
// reject observed collisions/changes rather than assuming create:true is exclusive.
export async function openCopyWriter(
  directory,
  name,
  { source = null, cancelled = () => false } = {},
) {
  const checkCancelled = () => {
    if (cancelled()) throw new DOMException("작업 취소", "AbortError");
  };
  checkCancelled();
  const handle = await directory.getFileHandle(name, { create: true });
  const initial = await handle.getFile();
  const checkTarget = async () => {
    checkCancelled();
    if (source) {
      if (typeof source.resolve !== "function")
        throw new Error(
          "원본과 저장 위치를 확인할 수 없어 복사를 중단했습니다.",
        );
      if ((await source.resolve(handle)) !== null)
        throw new Error("원본 폴더 안의 파일에는 쓸 수 없습니다.");
    }
    const current = await handle.getFile();
    if (
      initial.size !== 0 ||
      current.size !== 0 ||
      current.lastModified !== initial.lastModified
    )
      throw new Error(
        "저장 대상에 기존 파일 또는 외부 변경이 감지되어 복사를 중단했습니다.",
      );
    checkCancelled();
  };
  await checkTarget();
  // Supported implementations lock out competing browser writers. This does
  // not lock native applications or guarantee atomic non-existing creation.
  const writer = await handle.createWritable({ mode: "exclusive" });
  try {
    await checkTarget();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
  return {
    write: (bytes) => writer.write(bytes),
    async close() {
      await checkTarget();
      await writer.close();
    },
    abort: () => writer.abort(),
  };
}
