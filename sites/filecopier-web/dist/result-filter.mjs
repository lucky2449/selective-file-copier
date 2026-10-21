export const RESULT_FILTERS = [
  "all",
  "found",
  "attention",
  "missing",
  "selected",
];
export function matchesResultFilter(row, filter) {
  switch (filter) {
    case "found":
      return Boolean(row.chosen);
    case "attention":
      return !row.chosen && row.candidates.length > 0;
    case "missing":
      return !row.chosen && row.candidates.length === 0;
    case "selected":
      return Boolean(row.chosen && row.selected);
    default:
      return true;
  }
}
export function resultFilterCounts(rows) {
  const counts = Object.fromEntries(RESULT_FILTERS.map((key) => [key, 0]));
  for (const row of rows)
    for (const key of RESULT_FILTERS)
      if (matchesResultFilter(row, key)) counts[key]++;
  return counts;
}
