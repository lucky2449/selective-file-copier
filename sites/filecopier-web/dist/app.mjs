import { createAnalytics } from "./analytics.mjs";
import { measurementId } from "./analytics-config.mjs";
import { openCopyWriter } from "./copy-safety.mjs";
import {
  assertDistinctDirectories,
  createResultDirectory,
  selectNativeSource,
} from "./directory-access.mjs?v=source-safety-2";
import { bindSourcePicker } from "./source-picker.mjs";
import {
  parseItems,
  isExcludedFile,
  buildIndex,
  matchItem,
  extension,
  normalize,
  uniqueName,
  selectedFiles,
} from "./core.mjs?v=ext-dropdown-1";
import {
  buildFormatGroups,
  resolvePhotoPair,
  expandPhotoPairs,
} from "./photo-pairs.mjs?v=ext-dropdown-1";
import { writeZip } from "./zip.mjs";
const $ = (id) => document.getElementById(id);
const analytics = createAnalytics({ measurementId, window, document });
if (analytics.configured) $("analytics-notice").hidden = false;
analytics.start();
const canChooseDestination = typeof window.showDirectoryPicker === "function";
const defaultDestinationLabel = canChooseDestination
  ? "저장 폴더 선택 (선택 사항)"
  : "현재 브라우저는 폴더 직접 저장을 지원하지 않습니다";
const state = {
  files: [],
  rows: [],
  pairs: new Map(),
  extensions: new Set(),
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
  $("extension-summary").setAttribute("aria-disabled", String(value));
  if (value) $("extension-menu").open = false;
  for (const id of [
    "source",
    "source-alternative",
    "reset",
    "reference",
    "load-text",
    "items",
    "extension",
    "camera-numbers",
    "search",
    "select-all",
  ])
    $(id).disabled = value;
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
  $("destination").disabled = state.busy || !canChooseDestination;
  $("dest-label").textContent = state.dest?.name ?? defaultDestinationLabel;
  $("destination-reset").hidden = !state.dest;
  $("destination-reset").disabled = state.busy;
  $("save-hint").textContent = state.dest
    ? "선택한 저장 폴더 안에 새 결과 폴더를 만들어 복사합니다. 원본 파일은 변경하지 않습니다."
    : "미지정 시 각 파일을 일반 다운로드로 저장합니다. 저장 위치는 브라우저 설정을 따르며 새 폴더는 만들지 않습니다. 여러 파일 다운로드 허용이 필요할 수 있습니다.";
}
function outputFiles() {
  const files = selectedFiles(state.rows);
  return state.extensions !== null
    ? expandPhotoPairs(files, state.pairs)
    : files;
}
function updateSummary() {
  refreshSaveOptions();
  const selected = outputFiles(),
    resolved = state.rows.filter((row) => row.chosen).length;
  $("stat-total").textContent = state.rows.length;
  $("stat-found").textContent = resolved;
  $("stat-attention").textContent = state.rows.length - resolved;
  $("selected-count").textContent = `선택한 파일 ${selected.length}개`;
  $("copy").disabled = state.busy || !selected.length;
  $("zip").disabled = state.busy || !selected.length;
  $("copy").textContent = state.dest ? "선택 파일 복사" : "선택 파일 다운로드";
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
    if (row.chosen) {
      content.append(node("span", row.chosen.path, "file-path"));
      if (state.extensions !== null) {
        for (const file of state.pairs.get(row.chosen.path) ?? []) {
          if (file !== row.chosen)
            content.append(
              node("span", `함께 저장: ${file.path}`, "file-path"),
            );
        }
      }
    }
    if (row.candidates.length > 1 || row.requiresConfirmation) {
      const select = node("select", undefined, "row-select");
      select.setAttribute("aria-label", `${row.item}의 복사할 파일 선택`);
      select.append(
        new Option(
          row.requiresConfirmation
            ? `사진 번호 후보 ${row.candidates.length}개 · 확인 후 선택하세요`
            : `같은 이름 ${row.candidates.length}개 · 파일을 선택하세요`,
          "",
        ),
      );
      row.candidates.forEach((file, i) =>
        select.append(
          new Option(
            `${file.path}${row.candidateReasons?.has(file.path) ? " · " + row.candidateReasons.get(file.path) : ""}`,
            String(i),
          ),
        ),
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
        ? row.requiresConfirmation
          ? "번호 확인"
          : "파일 선택"
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
function updateExtensionLabel() {
  $("extension-summary").textContent =
    state.extensions === null
      ? "모든 파일"
      : state.extensions.size
        ? [...state.extensions]
            .sort()
            .map((ext) => ext || "확장자 없음")
            .join(", ")
        : "확장자 선택";
}
function renderExtensions() {
  updateExtensionLabel();
  $("extension-all").checked = state.extensions === null;
  $("extension-options").replaceChildren();
  const extensions = [
    ...new Set(state.files.map((file) => extension(file.name))),
  ].sort();
  for (const ext of extensions) {
    const label = node("label", undefined, "extension-option");
    const input = node("input");
    input.type = "checkbox";
    input.value = ext;
    input.checked = state.extensions?.has(ext) ?? false;
    input.addEventListener("change", () => {
      if (state.extensions === null) state.extensions = new Set();
      if (input.checked) state.extensions.add(ext);
      else state.extensions.delete(ext);
      $("extension-all").checked = false;
      updateExtensionLabel();
      invalidate();
    });
    label.append(input, node("span", ext || "확장자 없음"));
    $("extension-options").append(label);
  }
}
function acceptSource(files, name, source = null) {
  files = files.filter((file) => !isExcludedFile(file.name));
  state.files = files;
  state.pairs = new Map();
  state.extensions = new Set();
  state.source = source;
  state.dest = null;
  $("copy-output").hidden = true;
  $("dest-label").textContent = defaultDestinationLabel;
  $("source-name").textContent = name;
  $("source-detail").textContent =
    `${files.length.toLocaleString()}개 파일 · 하위 폴더 포함`;
  renderExtensions();
  invalidate();
  log(`원본 폴더: ${name} / ${files.length.toLocaleString()}개 파일`);
  if (!files.length) toast("선택한 폴더에 파일이 없습니다.");
}
// Keep the standard input available for normal downloads. Never retry an input after a native picker failure:
// a second picker would no longer have the original user activation.
bindSourcePicker({
  buttons: [$("source")],
  input: $("folder-input"),
  onFiles: (files, name) => acceptSource(files, name),
  onError: report,
});
$("source-alternative").hidden = !canChooseDestination;
if (canChooseDestination)
  $("source-alternative").addEventListener("click", async () => {
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
          "폴더 접근이 차단되었습니다. 위의 기본 ‘원본 폴더 선택’ 버튼으로 열면 일반 다운로드로 저장할 수 있습니다.",
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
      ...new Set(
        [...event.target.files]
          .filter((file) => !isExcludedFile(file.name))
          .map((file) => file.name),
      ),
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
$("extension-summary").addEventListener("click", (event) => {
  if (state.busy) event.preventDefault();
});
$("extension-all").addEventListener("change", () => {
  state.extensions = $("extension-all").checked ? null : new Set();
  renderExtensions();
  invalidate();
});
$("camera-numbers").addEventListener("change", invalidate);
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
  if (state.extensions?.size === 0) {
    toast("복사할 파일 확장자를 하나 이상 체크하세요.");
    return;
  }
  setBusy(true);
  state.cancelled = false;
  analytics.track("file_search");
  progress(0, "파일 검색 중...");
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.pairs =
      state.extensions === null
        ? new Map()
        : buildFormatGroups(state.files, state.extensions);
    const index = buildIndex(
        state.files,
        state.extensions === null ? "" : [...state.extensions],
        {
          cameraNumbers: $("camera-numbers").checked !== false,
        },
      ),
      rows = [];
    for (let i = 0; i < items.length; i++) {
      if (state.cancelled) throw new DOMException("작업 취소", "AbortError");
      const row = matchItem(index, items[i]);
      rows.push(
        state.extensions !== null ? resolvePhotoPair(row, state.pairs) : row,
      );
      if (i % 300 === 0) {
        progress((i / items.length) * 100, "파일 검색 중...");
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    state.rows = rows;
    render();
    const missing = rows.filter((row) => !row.candidates.length).length,
      ambiguous = rows.filter(
        (row) => row.candidates.length && !row.chosen,
      ).length;
    log(
      `검색 완료: 요청 ${rows.length}개 / 찾음 ${rows.length - missing - ambiguous}개 / 확인 필요 ${ambiguous}개 / 누락 ${missing}개`,
    );
    if (ambiguous)
      toast(
        "추정한 사진 번호 또는 중복 후보가 있습니다. 검색 결과에서 파일을 확인하고 선택하세요.",
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
    toast("저장 폴더를 지정하지 않고 일반 다운로드를 사용하세요.");
    return;
  }
  try {
    const dest = await window.showDirectoryPicker({ mode: "readwrite" });
    if (dest?.kind !== "directory")
      throw new Error("저장 폴더를 다시 선택하세요.");
    if (state.source) await assertDistinctDirectories(state.source, dest);
    state.dest = dest;
    $("dest-label").textContent = dest.name;
    updateSummary();
    log(`저장 폴더: ${dest.name}`);
  } catch (error) {
    if (["SecurityError", "NotAllowedError"].includes(error.name)) {
      toast(
        "이 폴더에 접근할 수 없습니다. 다른 폴더를 선택하거나 ‘일반 다운로드 사용’을 누르세요.",
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
  try {
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    a.remove();
  }
  // Keep the original Blob available while the browser starts the download.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function downloadFiles(files) {
  state.cancelled = false;
  setBusy(true);
  let requested = 0,
    failed = 0;
  const occupied = new Set();
  $("copy-output").textContent = "";
  $("copy-output").hidden = true;
  progress(0, "다운로드 요청 준비 중...");
  try {
    for (let i = 0; i < files.length; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 250));
      if (state.cancelled) break;
      const entry = files[i];
      try {
        const name = uniqueName(entry.name, occupied);
        download(entry.file, name);
        requested++;
        analytics.track("download_request");
        log(`다운로드 요청: ${entry.name} → ${name}`);
      } catch (error) {
        failed++;
        log(`다운로드 요청 실패: ${entry.name} (${error.message})`);
      }
      progress(
        ((i + 1) / files.length) * 100,
        `다운로드 요청 중 · ${i + 1} / ${files.length}개`,
      );
    }
    const summary = `${state.cancelled ? "다운로드 요청 취소" : "다운로드 요청 처리"} · 요청 ${requested}개 / 요청 실패 ${failed}개 / 미요청 ${files.length - requested - failed}개`;
    progress(((requested + failed) / files.length) * 100, summary);
    log(summary);
    toast(
      `${summary}. 실제 저장 여부는 브라우저 다운로드 목록에서 확인하세요.`,
    );
  } finally {
    setBusy(false);
  }
}
async function exportZip(usePicker = true) {
  const files = outputFiles();
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
    analytics.track("zip_created");
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
  const files = outputFiles();
  if (!files.length) return;
  if (!state.dest) {
    await downloadFiles(files);
    return;
  }
  state.cancelled = false;
  setBusy(true);
  progress(0, "저장 폴더 확인 중...");
  let success = 0,
    failed = 0;
  try {
    if (state.source) await assertDistinctDirectories(state.source, state.dest);
    // Every source mode writes only into a new result folder.
    const dest = await createResultDirectory(state.dest, {
      cancelled: () => state.cancelled,
    });
    if (state.source) await assertDistinctDirectories(state.source, dest);
    const outputLabel = `${state.dest.name}/${dest.name}`;
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
        newName = null;
      try {
        const file = entry.file;
        newName = uniqueName(entry.name, occupied);
        // Refresh collisions against changes made since the initial directory listing.
        while (true) {
          if (state.cancelled)
            throw new DOMException("작업 취소", "AbortError");
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
        writer = await openCopyWriter(dest, newName, {
          source: state.source,
          cancelled: () => state.cancelled,
        });
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
        if (state.cancelled) throw new DOMException("작업 취소", "AbortError");
        await writer.close();
        success++;
        log(`복사됨: ${entry.name} → ${newName}`);
      } catch (error) {
        if (writer) await writer.abort().catch(() => {});
        if (newName)
          log(`중단된 저장 대상은 자동 삭제하지 않습니다: ${newName}`);
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
    // One summary per copy operation; GA4 user metrics deduplicate visitors.
    analytics.recordCopyResult(success, failed);
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
  $("camera-numbers").checked = true;
  state.pairs = new Map();
  $("copy-output").hidden = true;
  $("source-name").textContent = "파일이 있는 폴더를 선택하세요";
  $("source-detail").textContent = "하위 폴더의 파일까지 함께 검색합니다";
  $("dest-label").textContent = defaultDestinationLabel;
  state.extensions = new Set();
  renderExtensions();
  $("log").textContent =
    "파일모아가 준비되었습니다. 원본 파일은 변경하지 않습니다.";
  invalidate();
});
renderExtensions();
render();
