// Directory identity must be verified from handles, never folder names.
export async function assertDistinctDirectories(source, destination) {
  if (
    source?.kind !== "directory" ||
    typeof source.isSameEntry !== "function"
  ) {
    throw new Error(
      "동일 폴더 확인을 위해 ‘폴더 직접 복사 모드로 열기’ 버튼으로 원본을 다시 선택하세요. 일반 다운로드는 그대로 사용할 수 있습니다.",
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
  if (typeof source.resolve !== "function")
    throw new Error("원본과 저장 위치를 확인할 수 없어 복사를 중단했습니다.");
  if ((await source.resolve(destination)) !== null)
    throw new Error(
      "원본 폴더 안에는 저장할 수 없습니다. 원본 밖의 저장 폴더를 선택하세요.",
    );
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

// Always isolate copies in a fresh, empty child folder.
export async function createResultDirectory(
  parent,
  {
    cancelled = () => false,
    makeName = () =>
      `파일모아_${new Date().toISOString().slice(0, 10)}_${crypto.randomUUID()}`,
  } = {},
) {
  if (
    parent?.kind !== "directory" ||
    typeof parent.getDirectoryHandle !== "function"
  )
    throw new Error("저장 폴더를 다시 선택하세요.");
  const check = () => {
    if (cancelled()) throw new DOMException("작업 취소", "AbortError");
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    check();
    const name = makeName();
    try {
      await parent.getDirectoryHandle(name);
      continue; // Never reuse an existing directory, including an original source.
    } catch (error) {
      if (error.name === "TypeMismatchError") continue;
      if (error.name !== "NotFoundError") throw error;
    }
    check();
    const result = await parent.getDirectoryHandle(name, { create: true });
    check();
    // A directory may have appeared between lookup and creation. Never reuse
    // a nonempty result, and never delete it as cleanup.
    for await (const entry of result.values()) {
      check();
      throw new Error(
        "결과 폴더에 기존 항목이 감지되어 복사를 중단했습니다. 다시 시도하세요.",
      );
    }
    check();
    return result;
  }
  throw new Error("새 결과 폴더 이름을 만들 수 없습니다. 다시 시도하세요.");
}
