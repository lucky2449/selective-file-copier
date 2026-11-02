export function planLocalMotionTiles(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 40_000_000) throw new TypeError('Invalid image dimensions');
  const w = Math.floor(width / 3), h = Math.floor(height / 3);
  const side = Math.min(w, h, 768);
  if (side < 128) return [];
  return Array.from({length: 9}, (_, i) => ({ index: i, x: Math.floor((i % 3) * width / 3) + Math.floor((w - side) / 2), y: Math.floor(Math.floor(i / 3) * height / 3) + Math.floor((h - side) / 2), width: side, height: side }));
}

// The face-motion classifier has not been calibrated for arbitrary scenes. Only
// repeated, spatially separate signals are used as an experimental early warning.
export function decideLocalMotion(samples) {
  if (!Array.isArray(samples)) return null;
  const groups = new Map();
  for (const sample of samples) {
    const d = sample?.decision;
    if (!Number.isInteger(sample.index) || sample.index < 0 || sample.index > 8 || d?.verdict !== 'motion_suspected' || d.evidence !== 'repeated_edge_peaks' || !Number.isFinite(d.directionDegrees)) continue;
    const set = groups.get(d.directionDegrees) ?? new Set();
    set.add(sample.index);
    groups.set(d.directionDegrees, set);
  }
  if ([...groups.values()].some(set => set.size >= 3)) return {verdict:'motion_suspected', reasons:['image_motion'], scope:'local_strong_motion', experimental:true};
  return null;
}
