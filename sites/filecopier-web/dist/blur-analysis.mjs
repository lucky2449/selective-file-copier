// Pure pixel analysis: no DOM, decoding, file handles, storage or network access.
// Input must be an already oriented, decoded, opaque JPEG RGBA image.
import { measureMotionEvidence, classifyMotionEvidence } from "./motion-evidence.mjs?v=motion-evidence-1";
export const BLUR_ALGORITHM_VERSION = "directional-blur-v2";
export const MAX_BLUR_INPUT_PIXELS = 40_000_000;

function abort(signal) {
  if (signal?.aborted) throw new DOMException("Analysis cancelled", "AbortError");
}
function invalid(message) { throw new TypeError(message); }

// Non-overlapping integer box averages. Never upscale or modify the input.
function resizeGray(source, width, height, targetWidth, targetHeight, rgba, signal) {
  const out = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y++) {
    abort(signal);
    const y0 = Math.floor(y * height / targetHeight), y1 = Math.floor((y + 1) * height / targetHeight);
    for (let x = 0; x < targetWidth; x++) {
      const x0 = Math.floor(x * width / targetWidth), x1 = Math.floor((x + 1) * width / targetWidth);
      let sum = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const i = sy * width + sx;
        if (rgba) {
          if (source[i * 4 + 3] !== 255) invalid("Opaque JPEG pixels required");
          sum += 0.299 * source[i * 4] + 0.587 * source[i * 4 + 1] + 0.114 * source[i * 4 + 2];
        } else sum += source[i];
      }
      out[y * targetWidth + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

function smooth3(gray, width, height, signal) {
  const out = new Float32Array(gray.length);
  const weights = [1, 2, 1];
  for (let y = 0; y < height; y++) {
    abort(signal);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
        sum += gray[Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx))] * weights[dx + 1] * weights[dy + 1];
      out[y * width + x] = sum / 16;
    }
  }
  return out;
}

function accumulator() { return { n: 0, sum: 0, squares: 0, gradients: 0 }; }
function summarize(value) {
  return {
    pixels: value.n,
    laplacianVariance: Math.max(0, value.squares / value.n - (value.sum / value.n) ** 2),
    // Sobel derivatives divided by 8; mean of gx² + gy² (not a probability).
    tenengrad: value.gradients / value.n,
  };
}
function measure(gray, width, height, signal) {
  const smooth = smooth3(gray, width, height, signal);
  const grid = Math.min(width, height) >= 96 ? 3 : 1;
  const regions = Array.from({ length: grid * grid }, accumulator), total = accumulator();
  for (let y = 2; y < height - 2; y++) {
    abort(signal);
    for (let x = 2; x < width - 2; x++) {
      const i = y * width + x;
      const lap = smooth[i - width] + smooth[i + width] + smooth[i - 1] + smooth[i + 1] - 4 * smooth[i];
      const gx = (-smooth[i - width - 1] + smooth[i - width + 1] - 2 * smooth[i - 1] + 2 * smooth[i + 1] - smooth[i + width - 1] + smooth[i + width + 1]) / 8;
      const gy = (-smooth[i - width - 1] - 2 * smooth[i - width] - smooth[i - width + 1] + smooth[i + width - 1] + 2 * smooth[i + width] + smooth[i + width + 1]) / 8;
      const region = regions[Math.min(grid - 1, Math.floor(y * grid / height)) * grid + Math.min(grid - 1, Math.floor(x * grid / width))];
      for (const value of [total, region]) {
        value.n++; value.sum += lap; value.squares += lap * lap; value.gradients += gx * gx + gy * gy;
      }
    }
  }
  return { width, height, grid, ...summarize(total), regions: regions.map(summarize), motion: measureMotionEvidence(smooth, width, height, signal) };
}

export function analyzeBlurPixels(image, { maxEdge = 768, signal } = {}) {
  abort(signal);
  const { width, height, data } = image ?? {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    invalid("Positive integer dimensions required");
  if (width * height > MAX_BLUR_INPUT_PIXELS) throw new RangeError("Decoded image exceeds analysis pixel limit");
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 128 || maxEdge > 1024) invalid("maxEdge must be an integer from 128 to 1024");
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4)
    invalid("Exact RGBA byte buffer required");
  const factor = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.floor(width * factor)), h = Math.max(1, Math.floor(height * factor));
  const base = { algorithmVersion: BLUR_ALGORITHM_VERSION, maxEdge, sourceWidth: width, sourceHeight: height };
  if (Math.min(w, h) < 64) return { ...base, status: "inconclusive", issues: ["insufficient_resolution"], scales: [] };
  const gray = resizeGray(data, width, height, w, h, true, signal);
  let sum = 0, squares = 0;
  for (const value of gray) { sum += value; squares += value * value; }
  const mean = sum / gray.length, deviation = Math.sqrt(Math.max(0, squares / gray.length - mean * mean));
  const issues = [];
  if (deviation < 8) issues.push("low_texture_or_contrast");
  if (mean < 8 || mean > 247) issues.push("extreme_exposure");
  const halfWidth = Math.floor(w / 2), halfHeight = Math.floor(h / 2);
  const scales = [measure(gray, w, h, signal), measure(resizeGray(gray, w, h, halfWidth, halfHeight, false, signal), halfWidth, halfHeight, signal)];
  return { ...base, status: issues.length ? "inconclusive" : "measured", meanLuminance: mean, luminanceDeviation: deviation, issues, scales };
}

// Legacy low-sharpness profiles are now measurement-only: never extract by score alone.
export function classifyBlur(metrics, profile) {
  if (!profile) return { verdict: "inconclusive", reasons: [], issue: "uncalibrated" };
  if (profile.algorithmVersion !== BLUR_ALGORITHM_VERSION || profile.maxEdge !== metrics.maxEdge ||
    !Array.isArray(profile.limits) || profile.limits.length !== 2 ||
    !profile.limits.every(limit => [limit?.laplacianVariance, limit?.tenengrad].every(n => Number.isFinite(n) && n > 0)))
    invalid("Matching algorithm version, maxEdge and two positive metric limits required");
  if (metrics.algorithmVersion !== BLUR_ALGORITHM_VERSION || metrics.status !== "measured" || metrics.scales?.length !== 2)
    return { verdict: "inconclusive", reasons: [], issue: metrics.issues?.[0] ?? "invalid_metrics" };
  const valid = metrics.scales.every(scale => Array.isArray(scale.regions) && scale.regions.length > 0 &&
    [scale, ...scale.regions].every(region => [region.laplacianVariance, region.tenengrad].every(n => Number.isFinite(n) && n >= 0)));
  if (!valid) return { verdict: "inconclusive", reasons: [], issue: "invalid_metrics" };
  const below = (region, limit) => region.laplacianVariance < limit.laplacianVariance && region.tenengrad < limit.tenengrad;
  const suspect = metrics.scales.every((scale, i) => [scale, ...scale.regions].every(region => below(region, profile.limits[i])));
  if (!suspect) return { verdict: "no_signal", reasons: [] };
  const motion = classifyMotionEvidence(metrics);
  return motion.verdict === "motion_suspected" ? motion : { verdict: "inconclusive", reasons: [], issue: "low_sharpness_without_confirmed_motion" };
}
export { classifyMotionEvidence };
