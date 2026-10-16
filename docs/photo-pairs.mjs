import { extension, normalize, stem } from "./core.mjs?v=raw-jpg-1";

const JPG = new Set([".jpg", ".jpeg", ".jpe"]);
const RAW = new Set([
  ".raw",
  ".cr2",
  ".cr3",
  ".nef",
  ".nrw",
  ".arw",
  ".sr2",
  ".srf",
  ".raf",
  ".rw2",
  ".rwl",
  ".orf",
  ".pef",
  ".dng",
  ".3fr",
  ".fff",
  ".x3f",
  ".gpr",
  ".iiq",
  ".srw",
  ".mrw",
]);
const kind = (file) =>
  JPG.has(extension(file.name))
    ? "jpg"
    : RAW.has(extension(file.name))
      ? "raw"
      : null;
const key = (file) => {
  const path = file.path.normalize("NFC").replace(/\\/g, "/");
  const slash = path.lastIndexOf("/");
  return path.slice(0, slash + 1) + normalize(stem(file.name));
};

// Only pair identical stems inside the same source directory. Never infer by number.
export function buildPhotoPairs(files) {
  const groups = new Map();
  for (const file of files) {
    if (!kind(file)) continue;
    const id = key(file);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(file);
  }
  const pairs = new Map();
  for (const group of groups.values()) {
    if (
      !group.some((f) => kind(f) === "jpg") ||
      !group.some((f) => kind(f) === "raw")
    )
      continue;
    for (const file of group) pairs.set(file.path, group);
  }
  return pairs;
}

// RAW/JPG candidates from one exact pair represent a single photo; other ambiguities remain manual.
export function resolvePhotoPair(row, pairs) {
  if (row.chosen || row.requiresConfirmation || row.candidates.length < 2)
    return row;
  const group = pairs.get(row.candidates[0].path);
  if (group && row.candidates.every((file) => group.includes(file))) {
    return {
      ...row,
      chosen:
        row.candidates.find((file) => kind(file) === "jpg") ??
        row.candidates[0],
      selected: true,
    };
  }
  return row;
}

export function expandPhotoPairs(files, pairs) {
  const result = new Map();
  for (const file of files) {
    result.set(file.path, file);
    for (const companion of pairs.get(file.path) ?? [])
      result.set(companion.path, companion);
  }
  return [...result.values()];
}
