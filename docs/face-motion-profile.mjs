// Pilot profile fitted on separate capture sessions; not a probability or universal threshold.
export const FACE_MOTION_PROFILE = Object.freeze({
  version: "face-edge-profiles-v1",
  minEdges: 6,
  minRegions: 3,
  widths: Object.freeze([6, 4]),
  ratio: 1.15,
  ghostRate: 0.1,
  minGhosts: 6,
  maxLaplacian: 2,
  maxTenengrad: 12,
});
