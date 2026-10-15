import {
  assertDistinctDirectories,
  createCopyDirectory,
  selectNativeSource,
} from "./directory-access.mjs";
import { bindSourcePicker } from "./source-picker.mjs";
import {
  parseItems,
  buildIndex,
  matchItem,
  stem,
  extension,
  normalize,
  uniqueName,
  selectedFiles,
} from "./core.mjs";
import { writeZip } from "./zip.mjs";
const $ = (id) => document.getElementById(id);
const canChooseDestination = typeof window.showDirectoryPicker === "function";
const defaultDestinationLabel = canChooseDestination
  ? "저장 폴더 선택 (선택 사항)"
  : "현재 브라우저는 폴더 직접 저장을 지원하지 않습니다";
const state = {
  files: [],
  rows: [],
  source: null,
  dest: null,
  busy: false,
  cancelled: false,
};
let toastTimer;
function log(message) {
  const lines = $("log").textContent.split("\n");
  lines.push(`[${new Date().toLocaleTimeString("ko-KR")}] ${message}`);
  $("log").textContent = lines.slice(-150).join("\n");
  $("log").scrollTop = $("log").scrollHeight;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}
function report(error) {
  if (error.name === "AbortError") return;
  log(`오류: ${error.message}`);
  toast(error.message);
}
function progress(value, message) {
  $("progress-wrap").hidden = false;
  $("progress").value = value;
  $("progress-label").textContent = message;
}
function setBusy(value) {
  state.busy = value;
  for (const id of [
    "source",
    "source-alternative",
    "reset",
    "reference",
    "load-text",
    "items",
    "extension",
    "search",
    "select-all",
  ])
    $(id).disabled = value;
  $("source").disabled = value || !canChooseDestination;
  $("cancel").hidden = !value;
  for (const input of $("rows").querySelectorAll("input,select"))
    input.disabled = value || input.dataset.unavailable === "true";
  updateSummary();
}
function invalidate() {
  state.rows = [];
  render();
  $("input-count").textContent =
    `${parseItems($("items").value).length}개 항목`;
  $("progress-wrap").hidden = true;
}
function refreshSaveOptions() {
  $("destination").disabled =
    state.busy || !canChooseDestination || !state.source;
  $("dest-label").textContent = state.dest?.name ?? defaultDestinationLabel;
  $("destination-reset").hidden = !state.dest;
  $("destination-reset").disabled = state.busy;
  $("save-hint").textContent = !canChooseDestination
    ? "폴더 직접 복사를 지원하지 않는 환경입니다. 데스크톱 Chrome·Edge의 새 탭에서 여세요. ZIP은 별도 대체 기능입니다."
    : state.source
      ? state.dest
        ? "선택 파일을 저장 폴더에 직접 복사합니다. 원본 파일은 변경하지 않습니다."
        : "미지정 시 복사 버튼을 누르면 다운로드 위치에서 시작하는 확인창이 열립니다. 확인한 위치에 새 폴더를 자동 생성합니다."
      : state.files.length
        ? "파일 선택창으로 읽은 원본은 ZIP 다운로드만 가능합니다. 직접 복사하려면 위의 원본 폴더 선택 버튼으로 다시 여세요."
        : "저장 위치 지정은 선택 사항입니다. 미지정 시 복사할 때 위치를 확인하고 새 폴더를 자동 생성합니다.";
}
function updateSummary() {
  refreshSaveOptions();
  const selected = selectedFiles(state.rows),
    resolved = state.rows.filter((row) => row.chosen).length;
  $("stat-total").textContent = state.rows.length;
  $("stat-found").textContent = resolved;
  $("stat-attention").textContent = state.rows.length - resolved;
  $("selected-count").textContent = `선택한 파일 ${selected.length}개`;
  $("copy").disabled = state.busy || !selected.length || !state.source;
  $("zip").disabled = state.busy || !selected.length;
  $("copy").textContent = "선택 파일 복사";
  const available = state.rows.filter((row) => row.chosen);
  $("select-all").checked =
    available.length > 0 && available.every((row) => row.selected);
  $("select-all").indeterminate =
    available.some((row) => row.selected) &&
    !available.every((row) => row.selected);
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function render() {
  $("rows").replaceChildren();
  $("empty").hidden = state.rows.length > 0;
  $("result-table").hidden = !state.rows.length;
  $("result-label").textContent = state.rows.length ? "검색 완료" : "준비 중";
  const fragment = document.createDocumentFragment();
  state.rows.forEach((row) => {
    const tr = node("tr"),
      checkCell = node("td"),
      content = node("td"),
      statusCell = node("td");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.checked = row.selected;
    checkbox.disabled = !row.chosen || state.busy;
    checkbox.dataset.unavailable = String(!row.chosen);
    checkbox.setAttribute("aria-label", `${row.item} 선택`);
    checkbox.addEventListener("change", () => {
      row.selected = checkbox.checked;
      updateSummary();
    });
    checkCell.append(checkbox);
    content.append(node("span", row.item, "file-name"));
    if (row.chosen) content.append(node("span", row.chosen.path, "file-path"));
    if (row.candidates.length > 1) {
      const select = node("select", undefined, "row-select");
      select.setAttribute("aria-label", `${row.item}의 복사할 파일 선택`);
      select.append(
        new Option(
          `같은 이름 ${row.candidates.length}개 · 파일을 선택하세요`,
          "",
        ),
      );
      row.candidates.forEach((file, i) =>
        select.append(new Option(file.path, String(i))),
      );
      if (row.chosen) select.value = String(row.candidates.indexOf(row.chosen));
      select.addEventListener("change", () => {
        row.chosen =
          select.value === "" ? null : row.candidates[Number(select.value)];
        row.selected = !!row.chosen;
        render();
      });
      content.append(select);
    }
    const text = row.chosen
      ? "찾음"
      : row.candidates.length
        ? "파일 선택"
        : "찾지 못함";
    statusCell.append(
      node(
        "span",
        text,
        `status ${row.chosen ? "" : row.candidates.length ? "warn" : "missing"}`,
      ),
    );
    tr.append(checkCell, content, statusCell);
    fragment.append(tr);
  });
  $("rows").append(fragment);
  updateSummary();
}
function acceptSource(files, name, source = null) {
  state.files = files;
  state.source = source;
  state.dest = null;
  $("copy-output").hidden = true;
  $("dest-label").textContent = defaultDestinationLabel;
  $("source-name").textContent = name;
  $("source-detail").textContent =
    `${files.length.toLocaleString()}개 파일 · 하위 폴더 포함`;
  $("extension").replaceChildren(new Option("모든 파일", ""));
  [...new Set(files.map((file) => extension(file.name)).filter(Boolean))]
    .sort()
    .forEach((ext) => $("extension").append(new Option(ext, ext)));
  invalidate();
  log(`원본 폴더: ${name} / ${files.length.toLocaleString()}개 파일`);
  if (!files.length) toast("선택한 폴더에 파일이 없습니다.");
}
// Keep ZIP fallback explicit. Never retry an input after a native picker failure:
// a second picker would no longer have the original user activation.
bindSourcePicker({
  buttons: [$("source-alternative")],
  input: $("folder-input"),
  onFiles: (files, name) => acceptSource(files, name),
  onError: report,
});
$("source").disabled = !canChooseDestination;
if (!canChooseDestination) {
  $("source-detail").textContent =
    "직접 복사는 데스크톱 Chrome·Edge의 새 탭에서 이용하세요";
}
$("source").addEventListener("click", async () => {
  if (!canChooseDestination) {
    toast("폴더 직접 복사를 지원하는 브라우저에서 사이트를 여세요.");
    return;
  }
  try {
    const selection = await selectNativeSource(
      (options) => window.showDirectoryPicker(options),
      {
        onScanning: () => {
          state.cancelled = false;
          setBusy(true);
          progress(0, "원본 폴더 읽는 중...");
        },
        cancelled: () => state.cancelled,
      },
    );
    acceptSource(selection.files, selection.name, selection.handle);
  } catch (error) {
    if (error.name === "SecurityError" || error.name === "NotAllowedError") {
      toast(
        "폴더 접근이 차단되었습니다. 데스크톱 Chrome·Edge의 새 탭에서 사이트를 열고 다시 선택하세요. ZIP 대체는 아래 파일 선택창 버튼을 사용하세요.",
      );
    } else report(error);
  } finally {
    setBusy(false);
    $("progress-wrap").hidden = true;
  }
});
$("reference").addEventListener("click", () => $("reference-input").click());
$("reference-input").addEventListener("change", (event) => {
  if (event.target.files.length) {
    $("items").value = [
      ...new Set([...event.target.files].map((file) => stem(file.name))),
    ]
      .map((name) => `"${name}"`)
      .join("\n");
    invalidate();
    log("선택한 파일의 이름을 목록으로 가져왔습니다.");
  }
  event.target.value = "";
});
$("load-text").addEventListener("click", () => $("text-input").click());
$("text-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024)
      throw new Error("TXT 목록은 5MB 이하로 선택하세요.");
    let bytes = await file.arrayBuffer();
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder("euc-kr").decode(bytes);
    }
    $("items").value = text;
    invalidate();
    log(`TXT 목록 불러옴: ${file.name}`);
  } catch (error) {
    report(error);
  }
});
$("items").addEventListener("input", invalidate);
$("extension").addEventListener("change", invalidate);
$("search").addEventListener("click", async () => {
  if (!state.files.length) {
    toast("원본 폴더를 먼저 선택하세요.");
    return;
  }
  const items = parseItems($("items").value);
  if (!items.length) {
    toast("찾을 숫자나 파일명을 입력하세요.");
    return;
  }
  if (items.length > 20000) {
    toast("한 번에 최대 20,000개 항목까지 검색할 수 있습니다.");
    return;
  }
  setBusy(true);
  state.cancelled = false;
  progress(0, "파일 검색 중...");
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const index = buildIndex(state.files, $("extension").value),
      rows = [];
    for (let i = 0; i < items.length; i++) {
      if (state.cancelled) throw new DOMException("작업 취소", "AbortError");
      rows.push(matchItem(index, items[i]));
      if (i % 300 === 0) {
        progress((i / items.length) * 100, "파일 검색 중...");
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    state.rows = rows;
    render();
    const missing = rows.filter((row) => !row.candidates.length).length,
      ambiguous = rows.filter((row) => row.candidates.length > 1).length;
    log(
      `검색 완료: 요청 ${rows.length}개 / 찾음 ${rows.length - missing - ambiguous}개 / 중복 후보 ${ambiguous}개 / 누락 ${missing}개`,
    );
    if (ambiguous)
      toast(
        "같은 이름의 파일이 있습니다. 검색 결과에서 복사할 파일을 선택하세요.",
      );
  } catch (error) {
    if (error.name === "AbortError") log("검색을 취소했습니다.");
    else report(error);
  } finally {
    setBusy(false);
    $("progress-wrap").hidden = true;
  }
});
$("select-all").addEventListener("change", () => {
  for (const row of state.rows)
    if (row.chosen) row.selected = $("select-all").checked;
  render();
});
$("destination").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    toast("이 브라우저에서는 ZIP 다운로드로 저장하세요.");
    return;
  }
  try {
    const dest = await window.showDirectoryPicker({ mode: "readwrite" });
    await assertDistinctDirectories(state.source, dest);
    state.dest = dest;
    $("dest-label").textContent = dest.name;
    updateSummary();
    log(`저장 폴더: ${dest.name}`);
  } catch (error) {
    if (error.name === "SecurityError") {
      toast(
        "폴더 저장은 사이트를 새 탭에서 열어 사용하거나 ZIP으로 내려받으세요.",
      );
    } else report(error);
  }
});
$("destination-reset").addEventListener("click", () => {
  state.dest = null;
  updateSummary();
});
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = node("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function exportZip(usePicker = true) {
  const files = selectedFiles(state.rows);
  if (!files.length) return;
  // File picker must be called during the initiating user gesture.
  let target = null;
  if (usePicker && window.showSaveFilePicker) {
    try {
      target = await window.showSaveFilePicker({
        suggestedName: "파일모아.zip",
        types: [
          { description: "ZIP 파일", accept: { "application/zip": [".zip"] } },
        ],
      });
    } catch (error) {
      if (error.name === "AbortError") return;
      if (error.name !== "SecurityError" && error.name !== "NotAllowedError") {
        report(error);
        return;
      }
    }
  }
  state.cancelled = false;
  setBusy(true);
  progress(0, "ZIP 파일 준비 중...");
  let sink;
  try {
    const occupied = new Set(),
      entries = [];
    for (const entry of files) {
      if (state.cancelled) throw new DOMException("작업 취소", "AbortError");
      entries.push({
        name: uniqueName(entry.name, occupied),
        file: entry.file,
      });
    }
    const total =
      entries.reduce((sum, entry) => sum + entry.file.size, 0) +
      entries.length * 512;
    if (total > 0xffffffff)
      throw new Error(
        "ZIP은 4GB 미만으로 나눠 저장하거나 저장 폴더로 직접 복사하세요.",
      );
    if (!target && total > 512 * 1024 * 1024)
      throw new Error(
        "이 환경의 ZIP 다운로드는 512MB까지 지원합니다. Chrome/Edge에서 사이트를 새 탭으로 열고 저장 폴더를 선택하세요.",
      );
    const parts = [];
    sink = target
      ? await target.createWritable()
      : { write: async (bytes) => parts.push(bytes) };
    await writeZip(entries, sink, {
      cancelled: () => state.cancelled,
      progress: (index, count, bytes, size) =>
        progress(
          Math.min(100, ((index + (size ? bytes / size : 0)) / count) * 100),
          `ZIP 저장 중 · ${Math.min(index + 1, count)} / ${count}개`,
        ),
    });
    if (target) await sink.close();
    else download(new Blob(parts, { type: "application/zip" }), "파일모아.zip");
    progress(100, `ZIP 저장 완료 · ${entries.length}개 파일`);
    log(
      `ZIP ${target ? "저장" : "다운로드 요청"} 완료: ${entries.length}개 파일`,
    );
    toast("선택한 파일을 ZIP으로 저장했습니다.");
  } catch (error) {
    if (sink?.abort) await sink.abort().catch(() => {});
    if (error.name === "AbortError") {
      log("ZIP 저장 취소");
      toast("작업을 취소했습니다.");
    } else report(error);
  } finally {
    setBusy(false);
  }
}
async function copyFiles() {
  if (state.busy) return;
  if (!state.source) {
    toast("직접 복사하려면 원본 폴더를 먼저 선택하세요.");
    return;
  }
  const files = selectedFiles(state.rows);
  if (!files.length) return;
  state.cancelled = false;
  setBusy(true);
  progress(0, "저장 폴더 확인 중...");
  let success = 0,
    failed = 0;
  try {
    let dest = state.dest;
    let outputLabel = dest?.name;
    if (!dest) {
      // Request access directly in the copy click, before any asynchronous work.
      const parent = await window.showDirectoryPicker({
        mode: "readwrite",
        startIn: "downloads",
      });
      dest = await createCopyDirectory(state.source, parent, {
        cancelled: () => state.cancelled,
      });
      outputLabel = `${parent.name}/${dest.name}`;
    }
    await assertDistinctDirectories(state.source, dest);
    if (state.cancelled) throw new DOMException("작업 취소", "AbortError");
    $("copy-output").textContent = `이번 저장 위치: ${outputLabel}`;
    $("copy-output").hidden = false;
    log(`저장 위치: ${outputLabel}`);
    const occupied = new Set();
    for await (const entry of dest.values()) {
      if (state.cancelled) break;
      occupied.add(normalize(entry.name));
    }
    for (let i = 0; i < files.length; i++) {
      if (state.cancelled) break;
      const entry = files[i];
      let writer = null,
        newName = null,
        created = false;
      try {
        const file = entry.file;
        newName = uniqueName(entry.name, occupied);
        // Refresh collisions against changes made since the initial directory listing.
        while (true) {
          try {
            await dest.getFileHandle(newName);
            newName = uniqueName(entry.name, occupied);
          } catch (error) {
            if (error.name === "NotFoundError") break;
            if (error.name === "TypeMismatchError") {
              newName = uniqueName(entry.name, occupied);
              continue;
            }
            throw error;
          }
        }
        const handle = await dest.getFileHandle(newName, {
          create: true,
        });
        created = true;
        writer = await handle.createWritable();
        const reader = file.stream().getReader();
        let bytes = 0;
        try {
          while (true) {
            if (state.cancelled)
              throw new DOMException("작업 취소", "AbortError");
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
            bytes += value.byteLength;
            progress(
              ((i + (file.size ? bytes / file.size : 1)) / files.length) * 100,
              `복사 중 · ${i + 1} / ${files.length}개 · ${entry.name}`,
            );
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        await writer.close();
        success++;
        log(`복사됨: ${entry.name} → ${newName}`);
      } catch (error) {
        if (writer) await writer.abort().catch(() => {});
        if (created)
          await dest
            .removeEntry(newName)
            .catch((cleanup) =>
              log(`미완성 파일 정리 실패: ${newName} (${cleanup.message})`),
            );
        if (error.name === "AbortError") break;
        failed++;
        log(`복사 실패: ${entry.name} (${error.message})`);
      }
      progress(
        ((i + 1) / files.length) * 100,
        `처리 중 · ${i + 1} / ${files.length}개`,
      );
    }
    const remaining = files.length - success - failed;
    const summary = `${state.cancelled ? "작업 취소" : "복사 완료"} · 성공 ${success}개 / 실패 ${failed}개 / 미처리 ${remaining}개`;
    progress(((success + failed) / files.length) * 100, summary);
    log(summary);
    toast(summary);
  } catch (error) {
    if (error.name === "AbortError") {
      log("저장 위치 선택 또는 복사를 취소했습니다.");
      toast("작업을 취소했습니다.");
    } else if (
      error.name === "SecurityError" ||
      error.name === "NotAllowedError"
    ) {
      report(
        new Error(
          "저장 폴더 접근이 허용되지 않았습니다. 지원 브라우저의 새 탭에서 다시 시도하거나 저장 폴더를 직접 선택하세요.",
        ),
      );
    } else report(error);
  } finally {
    setBusy(false);
  }
}
$("copy").addEventListener("click", copyFiles);
$("zip").addEventListener("click", () => exportZip(false));
$("cancel").addEventListener("click", () => {
  state.cancelled = true;
  $("progress-label").textContent = "현재 처리를 정리하고 취소합니다...";
});
$("reset").addEventListener("click", () => {
  Object.assign(state, {
    files: [],
    rows: [],
    source: null,
    dest: null,
    cancelled: false,
  });
  $("items").value = "";
  $("copy-output").hidden = true;
  $("source-name").textContent = "파일이 있는 폴더를 선택하세요";
  $("source-detail").textContent = canChooseDestination
    ? "하위 폴더의 파일까지 함께 검색합니다"
    : "직접 복사는 데스크톱 Chrome·Edge의 새 탭에서 이용하세요";
  $("dest-label").textContent = defaultDestinationLabel;
  $("extension").replaceChildren(new Option("모든 파일", ""));
  $("log").textContent =
    "파일모아가 준비되었습니다. 원본 파일은 변경하지 않습니다.";
  invalidate();
});
render();
