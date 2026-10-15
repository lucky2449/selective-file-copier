// Directory identity must be verified from handles, never folder names.
export async function assertDistinctDirectories(source, destination) {
  if (
    source?.kind !== "directory" ||
    typeof source.isSameEntry !== "function"
  ) {
    throw new Error(
      "동일 폴더 확인을 위해 ‘원본 폴더 선택’ 버튼으로 원본을 다시 선택하세요. 일반 다운로드는 그대로 사용할 수 있습니다.",
    );
  }
  if (destination?.kind !== "directory") {
    throw new Error("저장 폴더를 다시 선택하세요.");
  }
  if (await source.isSameEntry(destination)) {
    throw new Error(
      "원본 폴더와 저장 폴더가 같습니다. 다른 저장 폴더를 선택하세요.",
    );
  }
}

export async function readSourceDirectory(
  handle,
  { cancelled = () => false } = {},
) {
  const files = [];
  const check = () => {
    if (cancelled()) throw new DOMException("작업 취소", "AbortError");
  };
  async function visit(directory, prefix) {
    check();
    for await (const entry of directory.values()) {
      check();
      const path = `${prefix}/${entry.name}`;
      if (entry.kind === "directory") await visit(entry, path);
      else if (entry.kind === "file") {
        const file = await entry.getFile();
        check();
        files.push({ name: entry.name, path, file });
      }
    }
  }
  await visit(handle, handle.name);
  check();
  return files;
}

export async function selectNativeSource(
  chooseDirectory,
  { onScanning = () => {}, cancelled = () => false } = {},
) {
  // Invoke the picker before any await to preserve the initiating click gesture.
  const handle = await chooseDirectory({ mode: "read" });
  if (
    handle?.kind !== "directory" ||
    typeof handle.isSameEntry !== "function"
  ) {
    throw new Error(
      "이 브라우저에서는 폴더 동일 여부를 확인할 수 없습니다. 파일 선택창과 일반 다운로드를 사용하세요.",
    );
  }
  onScanning();
  const files = await readSourceDirectory(handle, { cancelled });
  return { files, name: handle.name, handle };
}
