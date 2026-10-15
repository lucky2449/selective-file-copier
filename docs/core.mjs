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
    if (!token[1] && /^[\d\s/]+$/.test(value))
      items.push(...value.split(/[\s/]+/).filter(Boolean));
    else items.push(value);
  }
  return [...new Set(items.map((v) => v.trim()).filter(Boolean))];
}
const add = (map, key, file) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(file);
};
export function buildIndex(files, filter = "") {
  const index = {
    targetExtension: filter.toLowerCase(),
    names: new Map(),
    stems: new Map(),
    ids: new Map(),
    paths: new Map(),
  };
  for (const file of files) {
    if (isExcludedFile(file.name)) continue;
    if (index.targetExtension && extension(file.name) !== index.targetExtension)
      continue;
    add(index.names, normalize(file.name), file);
    add(index.stems, normalize(stem(file.name)), file);
    const path = normalize(file.path);
    add(index.paths, path, file);
    // Each path suffix supports pasted Windows paths while retaining ambiguity.
    for (
      let slash = path.indexOf("/");
      slash >= 0;
      slash = path.indexOf("/", slash + 1)
    )
      add(index.paths, path.slice(slash + 1), file);
    const digits = stem(file.name).match(/(\d+)$/)?.[1];
    if (digits) add(index.ids, numericId(digits), file);
  }
  return index;
}
export function matchItem(index, item) {
  if (isExcludedFile(normalize(item).split("/").at(-1)))
    return { item, candidates: [], chosen: null, selected: false };
  const normalized = normalize(item);
  let candidates = [];
  if (normalized.includes("/")) {
    candidates = index.paths.get(normalized) ?? [];
    // Ignore unavailable drive prefixes by progressively trying path suffixes.
    for (
      let slash = normalized.indexOf("/");
      !candidates.length && slash >= 0;
      slash = normalized.indexOf("/", slash + 1)
    )
      candidates = index.paths.get(normalized.slice(slash + 1)) ?? [];
  }
  const name = normalized.split("/").at(-1);
  if (!candidates.length) candidates = index.names.get(name) ?? [];
  // A typed extension is exact by default. Cross-format lookup is allowed
  // only when the user explicitly selects a target extension filter.
  if (!candidates.length && (!extension(name) || index.targetExtension))
    candidates = index.stems.get(normalize(stem(name))) ?? [];
  if (!candidates.length && /^\d+$/.test(item))
    candidates = index.ids.get(numericId(item)) ?? [];
  candidates = [
    ...new Map(candidates.map((file) => [file.path, file])).values(),
  ];
  return {
    item,
    candidates,
    chosen: candidates.length === 1 ? candidates[0] : null,
    selected: candidates.length === 1,
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
