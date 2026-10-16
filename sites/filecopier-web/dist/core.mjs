import { recognizeCameraNumber } from "./camera-number.mjs";
// Pure matching functions shared by the browser and regression checks.
export const normalize = (value) =>
  value
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLocaleLowerCase("en-US");
export const extension = (name) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
};
export const stem = (name) =>
  extension(name) ? name.slice(0, -extension(name).length) : name;
// Exclude Windows download-origin sidecars without touching the source files.
export const isExcludedFile = (name) =>
  /(?:^|[.:])zone\.identifier(?::\$data)?$/i.test(name);
export const numericId = (value) => value.replace(/^0+(?=\d)/, "");
export function parseItems(text) {
  const items = [];
  for (const token of text
    .replace(/^\uFEFF/, "")
    .matchAll(/"([^"\r\n]+)"|([^,;\r\n]+)/g)) {
    const value = (token[1] ?? token[2]).trim();
    if (!value) continue;
    if (!token[1] && /^[\d\s/]+$/.test(value) && !/^\d+(?:\/\d+)+$/.test(value))
      items.push(...value.split(/[\s/]+/).filter(Boolean));
    else items.push(value);
  }
  return [...new Set(items.map((v) => v.trim()).filter(Boolean))];
}
const add = (map, key, file) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(file);
};
export function buildIndex(files, filter = "", { cameraNumbers = true } = {}) {
  const filters = (Array.isArray(filter) ? filter : filter ? [filter] : []).map(
    (ext) => ext.toLowerCase(),
  );
  const index = {
    targetExtension: filters.length === 1 ? filters[0] : "",
    hasExtensionFilter: filters.length > 0,
    names: new Map(),
    stems: new Map(),
    ids: new Map(),
    cameraIds: new Map(),
    paths: new Map(),
    pathStems: new Map(),
    roots: new Set(),
  };
  for (const file of files) {
    if (isExcludedFile(file.name)) continue;
    if (filters.length && !filters.includes(extension(file.name))) continue;
    add(index.names, normalize(file.name), file);
    add(index.stems, normalize(stem(file.name)), file);
    const path = normalize(file.path);
    add(index.paths, path, file);
    const pathStem =
      path.slice(0, path.lastIndexOf("/") + 1) + normalize(stem(file.name));
    add(index.pathStems, pathStem, file);
    // Only the selected source root may be omitted; never drop subfolders.
    const slash = path.indexOf("/");
    if (slash >= 0) {
      index.roots.add(path.slice(0, slash));
      add(index.paths, path.slice(slash + 1), file);
      add(index.pathStems, pathStem.slice(slash + 1), file);
    }
    const base = stem(file.name);
    const digits = base.match(/(\d+)$/)?.[1];
    const camera = cameraNumbers
      ? recognizeCameraNumber(base, extension(file.name))
      : null;
    if (digits && !camera?.ignoreTrailing)
      add(index.ids, numericId(digits), file);
    for (const hint of camera?.hints ?? []) {
      if (digits && !camera.ignoreTrailing && hint.id === numericId(digits))
        continue;
      add(index.cameraIds, hint.id, { file, reason: hint.reason });
    }
  }
  return index;
}
function pathMatches(index, requested, byStem = false) {
  const absolute = /^[a-z]:\//.test(requested) || requested.startsWith("/");
  let path = requested;
  if (absolute) {
    const parts = requested.split("/").filter(Boolean);
    const anchors = parts
      .slice(0, -1)
      .map((part, i) => (index.roots.has(part) ? i : -1))
      .filter((i) => i >= 0);
    // The browser does not expose absolute source paths. An unclear root must
    // fail closed instead of trying progressively shorter path suffixes.
    if (anchors.length !== 1) return [];
    path = parts.slice(anchors[0]).join("/");
  }
  const key = byStem
    ? path.slice(0, path.lastIndexOf("/") + 1) +
      normalize(stem(path.split("/").at(-1)))
    : path;
  const candidates = (byStem ? index.pathStems : index.paths).get(key) ?? [];
  if (!absolute) return candidates;
  // Absolute requests must match the full source-root path, not a relative alias.
  return candidates.filter((file) => {
    const actual = normalize(file.path);
    const full = byStem
      ? actual.slice(0, actual.lastIndexOf("/") + 1) +
        normalize(stem(file.name))
      : actual;
    return full === key;
  });
}

export function matchItem(index, item) {
  if (isExcludedFile(normalize(item).split("/").at(-1)))
    return { item, candidates: [], chosen: null, selected: false };
  const normalized = normalize(item);
  let candidates = [];
  let requiresConfirmation = false;
  const candidateReasons = new Map();
  const name = normalized.split("/").at(-1);
  if (normalized.includes("/")) {
    candidates = pathMatches(index, normalized);
    if (!candidates.length && (!extension(name) || index.hasExtensionFilter))
      candidates = pathMatches(index, normalized, true);
  } else {
    candidates = index.names.get(name) ?? [];
    // Filename-only queries may search every folder. A selected format allows
    // cross-format lookup, while unfiltered explicit extensions remain exact.
    if (!candidates.length && (!extension(name) || index.hasExtensionFilter))
      candidates = index.stems.get(normalize(stem(name))) ?? [];
  }
  if (!candidates.length && /^\d+$/.test(item)) {
    const id = numericId(item);
    const inferred = index.cameraIds.get(id) ?? [];
    candidates = [
      ...(index.ids.get(id) ?? []),
      ...inferred.map((entry) => entry.file),
    ];
    requiresConfirmation = inferred.length > 0;
    for (const entry of inferred)
      candidateReasons.set(entry.file.path, entry.reason);
  }
  candidates = [
    ...new Map(candidates.map((file) => [file.path, file])).values(),
  ];
  return {
    item,
    candidates,
    chosen:
      candidates.length === 1 && !requiresConfirmation ? candidates[0] : null,
    selected: candidates.length === 1 && !requiresConfirmation,
    requiresConfirmation,
    candidateReasons,
  };
}
export function uniqueName(name, occupied) {
  const base = stem(name),
    ext = extension(name);
  let candidate = name,
    count = 1;
  while (occupied.has(normalize(candidate)))
    candidate = `${base}_${count++}${ext}`;
  occupied.add(normalize(candidate));
  return candidate;
}
export function selectedFiles(rows) {
  return [
    ...new Map(
      rows
        .filter(
          (row) =>
            row.selected && row.chosen && !isExcludedFile(row.chosen.name),
        )
        .map((row) => [row.chosen.path, row.chosen]),
    ).values(),
  ];
}
