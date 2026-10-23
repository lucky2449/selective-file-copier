// Conservative experimental edge-spread evidence. No file/DOM/network access.
// Natural directional edges can still imitate motion; these are not probabilities.
export const MOTION_EVIDENCE_VERSION = "directional-spread-v1";
export const MOTION_SENSITIVITY = Object.freeze({
  strict: Object.freeze({ minWidths: Object.freeze([5.5, 3.5]), ratios: Object.freeze([2, 1.3]), sharpMax: 3.2, minEdges: 24, minRegions: 3 }),
  balanced: Object.freeze({ minWidths: Object.freeze([5, 3.2]), ratios: Object.freeze([1.8, 1.15]), sharpMax: 3.5, minEdges: 22, minRegions: 3 }),
});
const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1]];
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function summarize(bins) {
  return bins.map(widths => ({ edges: widths.length, medianWidth: median(widths) }));
}
export function measureMotionEvidence(smooth, width, height, signal) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
    width * height > 1024 * 1024 || !(smooth instanceof Float32Array) || smooth.length !== width * height)
    throw new TypeError("Bounded grayscale analysis buffer required");
  const grid = 3, bins = DIRECTIONS.map(() => []);
  const patches = Array.from({ length: 9 }, () => DIRECTIONS.map(() => []));
  if (Math.min(width, height) < 96) return { version: MOTION_EVIDENCE_VERSION, directions: summarize(bins), regions: [] };
  for (let y = 10; y < height - 10; y += 3) {
    if (signal?.aborted) throw new DOMException("Analysis cancelled", "AbortError");
    for (let x = 10; x < width - 10; x += 3) {
      const i = y * width + x;
      const gx = (smooth[i + 1] - smooth[i - 1]) / 2, gy = (smooth[i + width] - smooth[i - width]) / 2;
      const magnitude = Math.hypot(gx, gy);
      if (magnitude < 2) continue;
      for (let d = 0; d < DIRECTIONS.length; d++) {
        const [dx, dy] = DIRECTIONS[d], length = Math.hypot(dx, dy), step = dy * width + dx;
        if (Math.abs((gx * dx + gy * dy) / (magnitude * length)) < 0.93) continue;
        const peak = Math.abs(smooth[i + step] - smooth[i - step]) / 2;
        const previous = Math.abs(smooth[i] - smooth[i - 2 * step]) / 2;
        const next = Math.abs(smooth[i + 2 * step] - smooth[i]) / 2;
        if (peak < previous || peak <= next || peak < 2) continue;
        let variation = 0, last = smooth[i - 8 * step];
        const first = last;
        for (let t = -7; t <= 8; t++) {
          const value = smooth[i + t * step]; variation += Math.abs(value - last); last = value;
        }
        const contrast = Math.abs(last - first);
        if (contrast < 30 || contrast / Math.max(variation, 1) < 0.9) continue;
        const spread = contrast / peak * length;
        if (!Number.isFinite(spread) || spread > 13) continue;
        bins[d].push(spread);
        const patch = Math.min(grid - 1, Math.floor(y * grid / height)) * grid + Math.min(grid - 1, Math.floor(x * grid / width));
        patches[patch][d].push(spread);
      }
    }
  }
  return { version: MOTION_EVIDENCE_VERSION, directions: summarize(bins), regions: patches.map(summarize) };
}

// Thresholds are deliberately strict experimental heuristics, not calibrated accuracy.
// Require wide edges in one direction AND sharper perpendicular edges, across regions/scales.
export function classifyMotionEvidence(metrics, { sensitivity = "balanced" } = {}) {
  if (!Object.hasOwn(MOTION_SENSITIVITY, sensitivity)) throw new TypeError("Unknown motion sensitivity");
  const settings = MOTION_SENSITIVITY[sensitivity];
  const no = issue => ({ verdict: "inconclusive", reasons: [], issue, experimental: true, sensitivity });
  if (metrics?.status !== "measured" || metrics.issues?.length || metrics.scales?.length !== 2)
    return no(metrics?.issues?.[0] ?? "insufficient_image_evidence");
  const evidence = metrics.scales.map(scale => scale.motion);
  const valid = evidence.every(value => value?.version === MOTION_EVIDENCE_VERSION && value.directions?.length === 4 && value.regions?.length === 9 &&
    [value.directions, ...value.regions].every(bins => bins.length === 4 && bins.every(bin => Number.isSafeInteger(bin.edges) && bin.edges >= 0 &&
      (bin.edges === 0 ? bin.medianWidth === null : Number.isFinite(bin.medianWidth) && bin.medianWidth > 0))));
  if (!valid) return no("insufficient_directional_evidence");
  for (let d = 0; d < 4; d++) {
    const perpendicular = (d + 2) % 4;
    let common = null;
    const passed = evidence.every((value, scale) => {
      const broad = value.directions[d], sharp = value.directions[perpendicular];
      const minWidth = settings.minWidths[scale];
      const ratio = settings.ratios[scale];
      if (broad.edges < settings.minEdges || sharp.edges < settings.minEdges || broad.medianWidth < minWidth || sharp.medianWidth > settings.sharpMax || broad.medianWidth / sharp.medianWidth < ratio) return false;
      const regions = value.regions.map((bins, i) => ({ broad: bins[d], sharp: bins[perpendicular], i }))
        .filter(({ broad: b, sharp: s }) => b.edges >= 4 && s.edges >= 4 && b.medianWidth >= minWidth && s.medianWidth <= settings.sharpMax && b.medianWidth / s.medianWidth >= ratio)
        .map(region => region.i);
      common = common === null ? new Set(regions) : new Set(regions.filter(i => common.has(i)));
      return regions.length >= settings.minRegions;
    });
    if (passed && common?.size >= settings.minRegions) return { verdict: "motion_suspected", reasons: ["motion"], directionDegrees: d * 45, supportingRegions: [...common], experimental: true, sensitivity };
  }
  return { verdict: "no_signal", reasons: [], issue: "no_consistent_motion_evidence", experimental: true, sensitivity };
}
