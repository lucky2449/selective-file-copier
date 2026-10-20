import { createPreviewResolver, createPreviewManager } from "./thumbnail.mjs?v=orientation-1";
import { createOperationLogger } from "./operation-log.mjs?v=operation-log-1";
import { operationLogConfig } from "./operation-log-config.mjs?v=quota-cleanup-1";
import {
  APP_VERSION,
  createSaveNotice,
  createDiagnostics,
} from "./save-policy.mjs?v=quota-cleanup-1";
import { createAnalytics } from "./analytics.mjs";
import { measurementId } from "./analytics-config.mjs";
import { withCopyLock } from "./copy-lock.mjs?v=copy-lock-1";
import { openCopyWriter } from "./copy-safety.mjs?v=source-protection-2";
import {
  assertDistinctDirectories,
  createResultDirectory,
} from "./directory-access.mjs?v=short-time-name-1";
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
} from "./core.mjs?v=selected-formats-1";
import {
  buildFormatGroups,
  resolvePhotoPair,
  expandPhotoPairs,
} from "./photo-pairs.mjs?v=selected-formats-1";
import { prepareZipDownload } from "./zip-download.mjs?v=quota-cleanup-1";
const $ = (id) => document.getElementById(id);
const diagnostics = createDiagnostics(window.navigator?.userAgent);
const operationLogger = createOperationLogger({
  window,
  config: operationLogConfig,
  appVersion: APP_VERSION,
});
const confirmSave = createSaveNotice(window, {
  operationLogsEnabled: operationLogger.enabled,
  retentionDays: operationLogConfig.retentionDays,
});
if (operationLogger.enabled) {
  $("operation-log-notice").hidden = false;
  $("operation-log-retention").textContent =
    `${operationLogConfig.retentionDays}일`;
  operationLogger.visit();
}
function sizeMismatch(message) {
  return Object.assign(new Error(message), { code: "SIZE_MISMATCH" });
}
function operationSize(files) {
  return {
    selectedCount: files.length,
    selectedBytes: files.reduce((sum, entry) => sum + entry.file.size, 0),
  };
}
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
  copyAbort: null,
};
let previewFor = createPreviewResolver([]);
const previews = createPreviewManager({ window, document, root: document.querySelector?.('.result-scroll') });
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
    : "저장 폴더 미지정 시 브라우저 다운로드로 저장합니다.";
}
function outputFiles() {
  const files = selectedFiles(state.rows);
  return expandPhotoPairs(files, state.pairs);
}
function updateSummary() {
  refreshSaveOptions();
  const selected = outputFiles(),
    resolved = state.rows.filter((row) => row.chosen).length;
  $("stat-total").textContent = state.rows.length;
  $("stat-found").textContent = resolved;
  $("stat-attention").textContent = state.rows.length - resolved;
  $("selected-count").textContent = `선택한 파일 ${selected.length}개`;
  const totalBytes = selected.reduce((sum, entry) => sum + entry.file.size, 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit =
    totalBytes > 0
      ? Math.min(
          Math.floor(Math.log(totalBytes) / Math.log(1024)),
          units.length - 1,
        )
      : 0;
  const size = totalBytes / 1024 ** unit;
  const formattedSize = `${size.toLocaleString("ko-KR", { maximumFractionDigits: unit ? 1 : 0 })}${units[unit]}`;
  $("summary-selection").textContent =
    `저장 예정 ${selected.length.toLocaleString("ko-KR")}개 · 총 ${formattedSize}`;
  const formats = new Map();
  for (const entry of selected) {
    const format =
      extension(entry.name).slice(1).toUpperCase() || "확장자 없음";
    formats.set(format, (formats.get(format) ?? 0) + 1);
  }
  $("summary-formats").textContent =
    [...formats]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([format, count]) => `${format} ${count.toLocaleString("ko-KR")}개`)
      .join(" · ") || "선택한 파일 없음";
  const missing = state.rows.filter(
    (row) => !row.chosen && !row.candidates.length,
  ).length;
  const attention = state.rows.filter(
    (row) => !row.chosen && row.candidates.length,
  ).length;
  $("summary-requests").textContent =
    `찾지 못함 ${missing.toLocaleString("ko-KR")}건 · 확인 필요 ${attention.toLocaleString("ko-KR")}건`;
  $("copy").disabled = state.busy || !selected.length;
  $("zip").disabled = state.busy || !selected.length;
  $("zip").textContent =
    typeof window.navigator?.storage?.getDirectory === "function"
      ? "ZIP 다운로드 (최대 약 4GB) ↓"
      : "ZIP 다운로드 (최대 512MB) ↓";
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
  previews.reset();
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
    content.className = "result-file-cell";
    previews.attach(content, previewFor(row.chosen));
    content.append(node("span", row.item, "file-name"));
    if (row.chosen) {
      content.append(node("span", row.chosen.path, "file-path"));
      for (const file of state.pairs.get(row.chosen.path) ?? []) {
        if (file !== row.chosen)
          content.append(node("span", `함께 저장: ${file.path}`, "file-path"));
      }
    }
    const photoGroup = row.chosen ? state.pairs.get(row.chosen.path) : null;
    const samePhoto =
      photoGroup && row.candidates.every((file) => photoGroup.includes(file));
    if (row.requiresConfirmation || (row.candidates.length > 1 && !samePhoto)) {
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
function availableExtensions() {
  return [...new Set(state.files.map((file) => extension(file.name)))].sort();
}
function updateExtensionLabel() {
  const extensions = availableExtensions();
  const count = state.extensions.size;
  const all = extensions.length > 0 && count === extensions.length;
  $("extension-all").checked = all;
  $("extension-all").indeterminate = count > 0 && !all;
  $("extension-all-label").textContent =
    count > 0 && !all
      ? `일부 선택 (${count}/${extensions.length})`
      : "모두 선택";
  $("extension-all").disabled = !extensions.length;
  $("extension-summary").textContent = !extensions.length
    ? "원본 폴더를 선택하면 확장자가 표시됩니다."
    : `${count}개 형식 선택`;
}
function renderExtensions() {
  updateExtensionLabel();
  $("extension-options").replaceChildren();
  const extensions = availableExtensions();
  const counts = new Map();
  for (const entry of state.files) {
    const ext = extension(entry.name);
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  for (const ext of extensions) {
    const label = node("label", undefined, "extension-option");
    const input = node("input");
    input.type = "checkbox";
    input.value = ext;
    input.checked = state.extensions.has(ext);
    input.addEventListener("change", () => {
      if (input.checked) state.extensions.add(ext);
      else state.extensions.delete(ext);
      updateExtensionLabel();
      invalidate();
    });
    input.setAttribute(
      "aria-label",
      `${ext ? ext.slice(1).toUpperCase() : "확장자 없음"} 선택`,
    );
    label.append(
      input,
      node("span", ext ? ext.slice(1).toUpperCase() : "확장자 없음"),
      node(
        "span",
        counts.get(ext).toLocaleString("ko-KR"),
        "extension-file-count",
      ),
    );
    $("extension-options").append(label);
  }
}
function acceptSource(files, name, source = null) {
  files = files.filter((file) => !isExcludedFile(file.name));
  state.files = files;
  previewFor = createPreviewResolver(files);
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
$("extension-all").addEventListener("change", () => {
  state.extensions = $("extension-all").checked
    ? new Set(availableExtensions())
    : new Set();
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
  if (state.extensions.size === 0) {
    toast("복사할 파일 확장자를 하나 이상 체크하세요.");
    return;
  }
  setBusy(true);
  state.cancelled = false;
  analytics.track("file_search");
  progress(0, "파일 검색 중...");
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.pairs = buildFormatGroups(state.files, state.extensions);
    const index = buildIndex(state.files, [...state.extensions], {
        cameraNumbers: $("camera-numbers").checked !== false,
      }),
      rows = [];
    for (let i = 0; i < items.length; i++) {
      if (state.cancelled) throw new DOMException("작업 취소", "AbortError");
      const row = matchItem(index, items[i]);
      rows.push(resolvePhotoPair(row, state.pairs));
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
  const operation = operationLogger.begin("download", operationSize(files));
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
        operation.error(error, "download");
        log(`다운로드 요청 실패: ${entry.name} (${error.message})`);
      }
      progress(
        ((i + 1) / files.length) * 100,
        `다운로드 요청 중 · ${i + 1} / ${files.length}개`,
      );
    }
    diagnostics.record(
      "download",
      state.cancelled ? "cancelled" : failed ? "failed" : "requested",
    );
    const summary = `${state.cancelled ? "다운로드 요청 취소" : "다운로드 요청 처리"} · 요청 ${requested}개 / 요청 실패 ${failed}개 / 미요청 ${files.length - requested - failed}개`;
    progress(((requested + failed) / files.length) * 100, summary);
    log(summary);
    toast(
      `${summary}. 실제 저장 여부는 브라우저 다운로드 목록에서 확인하세요.`,
    );
  } finally {
    operation.finish({
      result: state.cancelled
        ? "cancelled"
        : failed
          ? requested
            ? "partial_failure"
            : "failed"
          : "download_requested",
      requested,
      failed,
    });
    setBusy(false);
  }
}
async function exportZip() {
  if (state.busy) return;
  const files = outputFiles();
  if (!files.length) return;
  if (!confirmSave()) return;
  diagnostics.record("zip", "started");
  const operation = operationLogger.begin("zip", operationSize(files));
  let preparedBytes = 0,
    archived = 0,
    requested = 0,
    zipCancelled = false,
    zipFailed = false;
  let zipPhase = "prepare";
  state.cancelled = false;
  const controller = new AbortController();
  state.copyAbort = controller;
  setBusy(true);
  $("copy-output").hidden = true;
  progress(0, "ZIP 파일 준비 중...");
  try {
    const occupied = new Set();
    const entries = files.map((entry) => ({
      name: uniqueName(entry.name, occupied),
      file: entry.file,
    }));
    diagnostics.record("zip", "writing");
    const blob = await prepareZipDownload(entries, {
      storage: window.navigator?.storage,
      cancelled: () => state.cancelled,
      progress: (index, count, bytes, size) =>
        progress(
          Math.min(100, ((index + (size ? bytes / size : 0)) / count) * 100),
          `ZIP 생성 중 · ${Math.min(index + 1, count)} / ${count}개`,
        ),
    });
    if (state.cancelled) throw new DOMException("작업 취소", "AbortError");
    preparedBytes = blob.size;
    archived = entries.length;
    zipPhase = "download";
    download(blob, "파일모아.zip");
    requested = entries.length;
    progress(100, `ZIP 다운로드 요청 완료 · ${entries.length}개 파일`);
    log(`ZIP 다운로드 요청 완료: ${entries.length}개 파일`);
    toast(
      "ZIP 다운로드를 요청했습니다. 실제 저장 여부는 브라우저 다운로드 목록에서 확인하세요.",
    );
    diagnostics.record("zip", "requested");
    analytics.track("zip_created");
  } catch (error) {
    zipFailed = true;
    zipCancelled = error.name === "AbortError";
    operation.error(error, zipPhase);
    if (error.name === "AbortError") {
      diagnostics.record("zip", "cancelled");
      log("ZIP 저장 취소 · 중단된 출력은 자동 삭제하지 않습니다.");
      toast("작업을 취소했습니다.");
    } else {
      diagnostics.record("zip", "failed");
      log("ZIP 저장 실패 · 중단된 출력은 자동 삭제하지 않습니다.");
      report(error);
    }
  } finally {
    operation.finish({
      result: zipCancelled
        ? "cancelled"
        : zipFailed
          ? "failed"
          : "download_requested",
      requested,
      archived,
      preparedBytes,
    });
    state.copyAbort = null;
    setBusy(false);
  }
}
async function copyFiles() {
  if (state.busy) return;
  const files = outputFiles();
  if (!files.length) return;
  if (!confirmSave()) return;
  diagnostics.record(state.dest ? "copy" : "download", "started");
  if (!state.dest) {
    await downloadFiles(files);
    return;
  }
  const operation = operationLogger.begin("copy", operationSize(files));
  let writtenBytes = 0,
    phase = "location-check",
    operationError = false,
    operationCancelled = false;
  state.cancelled = false;
  setBusy(true);
  const controller = new AbortController();
  state.copyAbort = controller;
  $("copy-output").hidden = true;
  progress(0, "저장 폴더 확인 중...");
  let success = 0,
    failed = 0;
  try {
    diagnostics.record("copy", "location-check");
    await withCopyLock(
      async () => {
        if (state.source)
          await assertDistinctDirectories(state.source, state.dest);
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
        diagnostics.record("copy", "writing");
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
            phase = "open";
            writer = await openCopyWriter(dest, newName, {
              source: state.source,
              cancelled: () => state.cancelled,
            });
            phase = "read";
            const reader = file.stream().getReader();
            let bytes = 0;
            try {
              while (true) {
                if (state.cancelled)
                  throw new DOMException("작업 취소", "AbortError");
                phase = "read";
                const { done, value } = await reader.read();
                if (done) break;
                if (bytes + value.byteLength > file.size)
                  throw sizeMismatch(
                    "읽은 데이터가 원본 파일 크기를 초과하여 복사를 중단했습니다. 원본을 다시 선택하세요.",
                  );
                phase = "write";
                await writer.write(value);
                bytes += value.byteLength;
                progress(
                  ((i + (file.size ? bytes / file.size : 1)) / files.length) *
                    100,
                  `복사 중 · ${i + 1} / ${files.length}개 · ${entry.name}`,
                );
              }
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
            if (state.cancelled)
              throw new DOMException("작업 취소", "AbortError");
            if (bytes !== file.size)
              throw sizeMismatch(
                "읽은 데이터와 원본 파일 크기가 달라 복사를 중단했습니다. 원본을 다시 선택하세요.",
              );
            phase = "close";
            await writer.close();
            writtenBytes += bytes;
            success++;
            log(`복사됨: ${entry.name} → ${newName}`);
          } catch (error) {
            if (writer) await writer.abort().catch(() => {});
            if (newName)
              log(`중단된 저장 대상은 자동 삭제하지 않습니다: ${newName}`);
            operation.error(error, phase);
            if (error.name === "AbortError") {
              operationCancelled = true;
              break;
            }
            failed++;
            log(`복사 실패: ${entry.name} (${error.message})`);
          }
          progress(
            ((i + 1) / files.length) * 100,
            `처리 중 · ${i + 1} / ${files.length}개`,
          );
        }
        diagnostics.record(
          "copy",
          state.cancelled ? "cancelled" : failed ? "failed" : "completed",
        );
        const remaining = files.length - success - failed;
        const summary = `${state.cancelled ? "작업 취소" : "복사 완료"} · 성공 ${success}개 / 실패 ${failed}개 / 미처리 ${remaining}개`;
        progress(((success + failed) / files.length) * 100, summary);
        log(summary);
        toast(summary);
      },
      {
        locks: window.navigator?.locks,
        signal: controller.signal,
        onWaiting: () => {
          progress(
            0,
            "폴더 복사 순서 대기 중 · 다른 탭의 복사가 끝나면 시작합니다",
          );
          log(
            "폴더 복사 잠금을 요청했습니다. 다른 탭에서 복사 중이면 순서를 기다립니다.",
          );
        },
        onAcquired: () => {
          progress(0, "저장 폴더 확인 중...");
          log("폴더 복사 잠금을 확보했습니다.");
        },
      },
    );
  } catch (error) {
    operationError = true;
    operationCancelled = error.name === "AbortError";
    operation.error(error, phase);
    if (error.name === "AbortError") {
      diagnostics.record("copy", "cancelled");
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
    operation.finish({
      result:
        state.cancelled || operationCancelled
          ? "cancelled"
          : operationError || failed
            ? success
              ? "partial_failure"
              : "failed"
            : "success",
      succeeded: success,
      failed,
      writtenBytes,
    });
    if (!state.cancelled && success + failed < files.length)
      diagnostics.record("copy", "failed");
    // One summary per copy operation; GA4 user metrics deduplicate visitors.
    state.copyAbort = null;
    analytics.recordCopyResult(success, failed);
    setBusy(false);
  }
}
$("copy").addEventListener("click", copyFiles);
$("zip").addEventListener("click", () => exportZip());
$("cancel").addEventListener("click", () => {
  state.cancelled = true;
  state.copyAbort?.abort();
  $("progress-label").textContent = "현재 처리를 정리하고 취소합니다...";
});
$("reset").addEventListener("click", () => {
  previewFor = createPreviewResolver([]);
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

$("diagnostics").addEventListener("click", () =>
  download(
    new Blob([diagnostics.export()], { type: "application/json" }),
    "filemoa-diagnostics.json",
  ),
);
