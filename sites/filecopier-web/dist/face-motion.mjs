// Native face edge profiles only: no I/O, identity recognition or original writes.
export const FACE_MOTION_VERSION = "face-edge-profiles-v1";
const median = (a) => {
  if (!a.length) return null;
  const b = [...a].sort((x, y) => x - y),
    m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};
const abort = (signal) => {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
};
function grayImage(image, signal) {
  const { width, height, data } = image ?? {};
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 768 * 768 ||
    !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
    data.length !== width * height * 4
  )
    throw new TypeError("Bounded native face crop required");
  const gray = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    abort(signal);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (data[i * 4 + 3] !== 255)
        throw new TypeError("Opaque face pixels required");
      gray[i] =
        0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
  }
  return gray;
}
const bin = () => ({
  widths: [],
  ghosts: 0,
  regions: new Set(),
  ghostRegions: new Set(),
});
function measure(gray, width, height, signal) {
  const smooth = new Float32Array(gray.length);
  for (let y = 1; y < height - 1; y++) {
    abort(signal);
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      smooth[i] =
        (gray[i - width - 1] +
          2 * gray[i - width] +
          gray[i - width + 1] +
          2 * gray[i - 1] +
          4 * gray[i] +
          2 * gray[i + 1] +
          gray[i + width - 1] +
          2 * gray[i + width] +
          gray[i + width + 1]) /
        16;
    }
  }
  const sample = (x, y) => {
    const ix = Math.floor(x),
      iy = Math.floor(y),
      a = x - ix,
      b = y - iy,
      i = iy * width + ix;
    return (
      smooth[i] * (1 - a) * (1 - b) +
      smooth[i + 1] * a * (1 - b) +
      smooth[i + width] * (1 - a) * b +
      smooth[i + width + 1] * a * b
    );
  };
  const detailRegions = Array.from({ length: 9 }, () => ({
    count: 0,
    sum: 0,
    squares: 0,
    gradients: 0,
  }));
  let count = 0,
    lapSum = 0,
    lapSquares = 0,
    gradientSquares = 0;
  for (let y = 2; y < height - 2; y++) {
    abort(signal);
    for (let x = 2; x < width - 2; x++) {
      const i = y * width + x,
        lap =
          smooth[i - width] +
          smooth[i + width] +
          smooth[i - 1] +
          smooth[i + 1] -
          4 * smooth[i];
      const gx =
        (-smooth[i - width - 1] +
          smooth[i - width + 1] -
          2 * smooth[i - 1] +
          2 * smooth[i + 1] -
          smooth[i + width - 1] +
          smooth[i + width + 1]) /
        8;
      const gy =
        (-smooth[i - width - 1] -
          2 * smooth[i - width] -
          smooth[i - width + 1] +
          smooth[i + width - 1] +
          2 * smooth[i + width] +
          smooth[i + width + 1]) /
        8;
      const region =
        detailRegions[
          Math.min(2, Math.floor((y * 3) / height)) * 3 +
            Math.min(2, Math.floor((x * 3) / width))
        ];
      region.count++;
      region.sum += lap;
      region.squares += lap * lap;
      region.gradients += gx * gx + gy * gy;
      count++;
      lapSum += lap;
      lapSquares += lap * lap;
      gradientSquares += gx * gx + gy * gy;
    }
  }
  const detail = {
    laplacianVariance: count
      ? Math.max(0, lapSquares / count - (lapSum / count) ** 2)
      : 0,
    tenengrad: count ? gradientSquares / count : 0,
  };
  const bins = Array.from({ length: 8 }, bin);
  if (Math.min(width, height) < 64) return { width, height, detail, bins: [] };
  for (let y = 17; y < height - 17; y += 3) {
    abort(signal);
    for (let x = 17; x < width - 17; x += 3) {
      const i = y * width + x,
        gx = (smooth[i + 1] - smooth[i - 1]) / 2,
        gy = (smooth[i + width] - smooth[i - width]) / 2,
        magnitude = Math.hypot(gx, gy);
      if (magnitude < 1.5) continue;
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      if (angle >= Math.PI) angle -= Math.PI;
      const d = Math.round((angle / Math.PI) * 8) % 8,
        nx = Math.cos((d * Math.PI) / 8),
        ny = Math.sin((d * Math.PI) / 8);
      const along = (t) => {
        let v = 0;
        for (let tangent = -2; tangent <= 2; tangent++)
          v += sample(x + nx * t - ny * tangent, y + ny * t + nx * tangent);
        return v / 5;
      };
      const local = Math.abs(along(0.5) - along(-0.5));
      if (
        local < Math.abs(along(-0.5) - along(-1.5)) ||
        local <= Math.abs(along(1.5) - along(0.5))
      )
        continue;
      const values = Array.from({ length: 27 }, (_, k) => along(k - 13));
      const signed = values[26] - values[0],
        contrast = Math.abs(signed);
      if (contrast < 16) continue;
      const sign = Math.sign(signed),
        g = [];
      let variation = 0,
        mass = 0;
      for (let k = 0; k < 26; k++) {
        const delta = (values[k + 1] - values[k]) * sign;
        variation += Math.abs(delta);
        g.push(Math.max(0, delta));
        mass += Math.max(0, delta);
      }
      if (contrast / Math.max(variation, 1) < 0.85 || mass <= 0) continue;
      let sum = 0,
        lo = -1,
        hi = -1;
      for (let k = 0; k < g.length; k++) {
        sum += g[k];
        if (lo < 0 && sum >= mass * 0.1) lo = k;
        if (hi < 0 && sum >= mass * 0.9) hi = k;
      }
      const spread = hi - lo;
      if (spread < 1 || spread > 22) continue;
      const maximum = Math.max(...g),
        peaks = [];
      if (Math.max(g[12], g[13]) < maximum * 0.8) continue;
      for (let k = 1; k < g.length - 1; k++)
        if (g[k] >= maximum * 0.25 && g[k] >= g[k - 1] && g[k] > g[k + 1])
          peaks.push(k);
      let ghost = false;
      for (let a = 0; a < peaks.length && peaks.length <= 3 && !ghost; a++)
        for (let b = a + 1; b < peaks.length; b++) {
          const left = peaks[a],
            right = peaks[b],
            distance = right - left;
          if (
            distance >= 3 &&
            distance <= 12 &&
            Math.min(...g.slice(left + 1, right)) <
              Math.min(g[left], g[right]) * 0.6 &&
            Math.min(g[left], g[right]) / Math.max(g[left], g[right]) >= 0.35
          ) {
            ghost = true;
            break;
          }
        }
      const region =
          Math.min(2, Math.floor((y * 3) / height)) * 3 +
          Math.min(2, Math.floor((x * 3) / width)),
        entry = bins[d];
      entry.widths.push(spread);
      entry.regions.add(region);
      if (ghost) {
        entry.ghosts++;
        entry.ghostRegions.add(region);
      }
    }
  }
  return {
    width,
    height,
    detail,
    detailRegions: detailRegions.map((r) => ({
      pixels: r.count,
      laplacianVariance: r.count
        ? Math.max(0, r.squares / r.count - (r.sum / r.count) ** 2)
        : 0,
      tenengrad: r.count ? r.gradients / r.count : 0,
    })),
    bins: bins.map((b) => ({
      edges: b.widths.length,
      medianWidth: median(b.widths),
      p20Width: b.widths.length
        ? [...b.widths].sort((a, b) => a - b)[
            Math.floor((b.widths.length - 1) * 0.2)
          ]
        : null,
      sharpEdges: b.widths.filter((v) => v <= 4).length,
      wideEdges: b.widths.filter((v) => v >= 4).length,
      ghosts: b.ghosts,
      regions: [...b.regions],
      ghostRegions: [...b.ghostRegions],
    })),
  };
}
export function measureFaceMotion(image, { signal } = {}) {
  abort(signal);
  const { width, height } = image,
    gray = grayImage(image, signal),
    w = Math.floor(width / 2),
    h = Math.floor(height / 2),
    half = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    abort(signal);
    for (let x = 0; x < w; x++) {
      const i = y * 2 * width + x * 2;
      half[y * w + x] =
        (gray[i] + gray[i + 1] + gray[i + width] + gray[i + width + 1]) / 4;
    }
  }
  return {
    version: FACE_MOTION_VERSION,
    scales: [measure(gray, width, height, signal), measure(half, w, h, signal)],
  };
}
// Explicit profile only; features do not prove that a photograph is sharp.
export function classifyFaceMotion(evidence, profile) {
  const no = (issue) => ({
    verdict: "inconclusive",
    reasons: [],
    issue,
    experimental: true,
  });
  if (!profile) return no("face_motion_uncalibrated");
  if (
    profile.version !== FACE_MOTION_VERSION ||
    ![profile.minEdges, profile.minRegions, profile.minGhosts].every(
      (v) => Number.isSafeInteger(v) && v > 0,
    ) ||
    !Array.isArray(profile.widths) ||
    profile.widths.length !== 2 ||
    !profile.widths.every((v) => Number.isFinite(v) && v > 0) ||
    !Number.isFinite(profile.ratio) ||
    profile.ratio < 1 ||
    !Number.isFinite(profile.ghostRate) ||
    profile.ghostRate <= 0 ||
    profile.ghostRate > 1 ||
    ![profile.maxLaplacian, profile.maxTenengrad].every(
      (v) => Number.isFinite(v) && v > 0,
    )
  )
    throw new TypeError("Explicit face motion profile required");
  if (
    evidence?.version !== FACE_MOTION_VERSION ||
    evidence.scales?.length !== 2 ||
    evidence.scales.some((s) => s.bins?.length !== 8)
  )
    return no("insufficient_face_edges");
  const detail = evidence.scales[0].detail;
  if (
    !detail ||
    ![detail.laplacianVariance, detail.tenengrad].every(
      (v) => Number.isFinite(v) && v >= 0,
    )
  )
    return no("invalid_face_detail");
  const validBin = (b) =>
    b &&
    Number.isSafeInteger(b.edges) &&
    b.edges >= 0 &&
    Number.isSafeInteger(b.ghosts) &&
    b.ghosts >= 0 &&
    b.ghosts <= b.edges &&
    Number.isSafeInteger(b.wideEdges) &&
    b.wideEdges >= 0 &&
    b.wideEdges <= b.edges &&
    (b.edges === 0
      ? b.medianWidth === null
      : Number.isFinite(b.medianWidth) && b.medianWidth > 0) &&
    [b.regions, b.ghostRegions].every(
      (a) =>
        Array.isArray(a) &&
        a.length <= 9 &&
        new Set(a).size === a.length &&
        a.every((i) => Number.isSafeInteger(i) && i >= 0 && i < 9),
    ) &&
    b.ghostRegions.every((i) => b.regions.includes(i));
  if (evidence.scales.some((s) => !s.bins.every(validBin)))
    return no("invalid_face_edges");
  if (
    detail.laplacianVariance >= profile.maxLaplacian ||
    detail.tenengrad >= profile.maxTenengrad
  )
    return { verdict: "no_signal", reasons: [], experimental: true };
  for (let d = 0; d < 8; d++) {
    let spread = true,
      ghost = true;
    for (let scale = 0; scale < 2; scale++) {
      const bins = evidence.scales[scale].bins,
        b = bins[d],
        perpendicular = bins[(d + 4) % 8];
      const enough =
        b.edges >= profile.minEdges && b.regions.length >= profile.minRegions;
      spread &&=
        enough &&
        b.medianWidth >= profile.widths[scale] &&
        perpendicular.edges >= profile.minEdges &&
        b.medianWidth / Math.max(perpendicular.medianWidth, 1) >= profile.ratio;
      ghost &&=
        enough &&
        b.ghosts >= profile.minGhosts &&
        b.ghosts / b.edges >= profile.ghostRate &&
        b.ghostRegions.length >= profile.minRegions;
    }
    const common = (key) =>
      evidence.scales[0].bins[d][key].filter((i) =>
        evidence.scales[1].bins[d][key].includes(i),
      ).length >= profile.minRegions;
    spread &&= common("regions");
    ghost &&= common("ghostRegions");
    if (spread || ghost)
      return {
        verdict: "motion_suspected",
        reasons: ["motion"],
        evidence: ghost ? "repeated_edge_peaks" : "directional_edge_spread",
        directionDegrees: d * 22.5,
        experimental: true,
      };
  }
  return { verdict: "no_signal", reasons: [], experimental: true };
}
