// Sharpness uses spatial Laplacian/Sobel measurements, independently of the
// directional monotonic-edge profiles used to detect motion. Pilot thresholds.
export function assessDetailEvidence(evidence) {
  const no = (issue) => ({
    completed: true,
    sufficient: false,
    sharpDetail: false,
    issue,
  });
  if (
    evidence?.version !== "face-edge-profiles-v1" ||
    evidence.scales?.length !== 2
  )
    return no("invalid_detail_evidence");
  const valid = (d) =>
    d &&
    [d.laplacianVariance, d.tenengrad].every(
      (v) => Number.isFinite(v) && v >= 0,
    );
  if (
    !evidence.scales.every(
      (s) =>
        valid(s.detail) &&
        Array.isArray(s.detailRegions) &&
        s.detailRegions.length === 9 &&
        s.detailRegions.every(
          (r) => valid(r) && Number.isSafeInteger(r.pixels) && r.pixels >= 64,
        ),
    )
  )
    return no("insufficient_spatial_samples");
  const limits = [
    { lap: 5, gradient: 8 },
    { lap: 10, gradient: 15 },
  ];
  const passes = (d, i) =>
    d.laplacianVariance >= limits[i].lap && d.tenengrad >= limits[i].gradient;
  const common = Array.from({ length: 9 }, (_, i) => i).filter((i) =>
    evidence.scales.every((s, scale) => passes(s.detailRegions[i], scale)),
  );
  const sufficient = true;
  const sharpDetail =
    evidence.scales.every((s, i) => passes(s.detail, i)) && common.length >= 3;
  return {
    completed: true,
    sufficient,
    sharpDetail,
    issue: sharpDetail ? null : "detail_not_confirmed",
  };
}
