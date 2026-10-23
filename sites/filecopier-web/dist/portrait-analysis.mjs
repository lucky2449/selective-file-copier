import { measureFaceMotion } from "./face-motion.mjs?v=spatial-detail-3";
import {
  medianDenoise,
  REFINEMENT_VERSION,
} from "./portrait-refinement.mjs?v=eye-noise-2";
import { analyzeBlurPixels } from "./blur-analysis.mjs?v=portrait-1";
export const PORTRAIT_ALGORITHM_VERSION = "native-face-eyes-v1";
export const MAX_REVIEW_JPEG_BYTES = 64 * 1024 * 1024;
export const MAX_REVIEW_PIXELS = 40_000_000;
export const MAX_REVIEW_FACES = 12;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const unit = (value) => finite(value) && value >= 0 && value <= 1;

// JPEG SOF is checked before image decoding. Metadata beyond the bounded header is unsupported.
export function readReviewJpegSize(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes[0] !== 255 || bytes[1] !== 216)
    throw new TypeError("JPEG required");
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i++] !== 255) throw new TypeError("Invalid JPEG header");
    while (i < bytes.length && bytes[i] === 255) i++;
    const marker = bytes[i++];
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    const length = bytes[i] * 256 + bytes[i + 1];
    if (length < 2 || i + length > bytes.length) break;
    if (
      [
        192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
      ].includes(marker)
    ) {
      if (length < 8) throw new TypeError("Invalid JPEG dimensions");
      const height = bytes[i + 3] * 256 + bytes[i + 4],
        width = bytes[i + 5] * 256 + bytes[i + 6];
      if (!width || !height || width * height > MAX_REVIEW_PIXELS)
        throw new RangeError("JPEG analysis pixel limit");
      return { width, height };
    }
    i += length;
  }
  throw new TypeError("JPEG dimensions unavailable in bounded header");
}

function boxArea(box) {
  return box.width * box.height;
}
function overlap(a, b) {
  const area =
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return area / (boxArea(a) + boxArea(b) - area);
}
function patch(cx, cy, side, width, height) {
  side = Math.floor(Math.min(side, width, height));
  return {
    x: clamp(Math.round(cx - side / 2), 0, width - side),
    y: clamp(Math.round(cy - side / 2), 0, height - side),
    width: side,
    height: side,
  };
}
export function planPortraitRegions({ width, height }, detections) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_REVIEW_PIXELS
  )
    throw new TypeError("Bounded oriented dimensions required");
  if (!Array.isArray(detections) || detections.length > 256)
    throw new TypeError("Bounded detections required");
  const valid = detections.filter(
    (face) =>
      unit(face?.score) &&
      unit(face?.box?.x) &&
      unit(face?.box?.y) &&
      unit(face?.box?.width) &&
      unit(face?.box?.height) &&
      face.box.width > 0 &&
      face.box.height > 0 &&
      face.box.x + face.box.width <= 1.001 &&
      face.box.y + face.box.height <= 1.001,
  );
  const unique = [];
  for (const face of [...valid].sort((a, b) => b.score - a.score))
    if (!unique.some((other) => overlap(face.box, other.box) > 0.35))
      unique.push(face);
  if (!detections.length)
    return {
      route: "global",
      issues: ["face_not_detected_not_proof_of_absence"],
      faces: [],
    };
  const faces = [],
    issues = [];
  for (const face of unique) {
    if (face.score < 0.7) {
      issues.push("uncertain_face_detection");
      continue;
    }
    if (face.eyesRefined === false) issues.push("eye_refinement_unavailable");
    const { box, eyes } = face;
    const fw = box.width * width,
      fh = box.height * height;
    if (Math.min(fw, fh) < 128) {
      issues.push("face_too_small");
      continue;
    }
    if (
      !Array.isArray(eyes) ||
      eyes.length !== 2 ||
      !eyes.every(
        (p) =>
          unit(p?.x) &&
          unit(p?.y) &&
          p.x >= box.x &&
          p.x <= box.x + box.width &&
          p.y >= box.y &&
          p.y <= box.y + box.height,
      )
    ) {
      issues.push("eye_positions_unreliable");
      continue;
    }
    const points = eyes.map((p) => ({ x: p.x * width, y: p.y * height }));
    const distance = Math.hypot(
      points[0].x - points[1].x,
      points[0].y - points[1].y,
    );
    if (
      distance < 60 ||
      distance > fw * 0.9 ||
      (!face.eyesRefined &&
        Math.abs(points[0].y - points[1].y) > distance * 0.6)
    ) {
      issues.push("eye_geometry_unreliable");
      continue;
    }
    if (faces.length >= MAX_REVIEW_FACES) {
      issues.push("face_limit");
      continue;
    }
    const side = clamp(distance * 0.7, 64, 256);
    faces.push({
      score: face.score,
      box: {
        x: Math.floor(box.x * width),
        y: Math.floor(box.y * height),
        width: Math.floor(fw),
        height: Math.floor(fh),
      },
      face: patch(
        (box.x + box.width / 2) * width,
        (box.y + box.height / 2) * height,
        Math.min(fw, fh, 768),
        width,
        height,
      ),
      eyes: points.map((point, i) =>
        patch(
          point.x,
          point.y,
          face.eyesRefined &&
            Array.isArray(face.eyeSides) &&
            finite(face.eyeSides[i])
            ? clamp(face.eyeSides[i], 64, 256)
            : side,
          width,
          height,
        ),
      ),
      eyesRefined: face.eyesRefined === true,
    });
  }
  if (valid.length !== detections.length) issues.push("invalid_face_detection");
  return {
    route: faces.length ? "portrait" : "inconclusive",
    issues: [...new Set(issues)],
    faces,
  };
}

// Conservative early exit: both native eye crops must exceed both calibrated
// thresholds by 2x. Thumbnail sharpness alone must never bypass portrait review.
function validProfile(profile) {
  if (profile?.algorithmVersion !== PORTRAIT_ALGORITHM_VERSION) return false;
  const keys = ["frequency-ratio-v1", "denoised-ratio-v1"].includes(
    profile.scoreMode,
  )
    ? ["faceRatio", "eyeRatio"]
    : ["faceLaplacian", "faceTenengrad", "eyeLaplacian", "eyeTenengrad"];
  return (
    (profile.scoreMode == null ||
      ["frequency-ratio-v1", "denoised-ratio-v1"].includes(
        profile.scoreMode,
      )) &&
    keys.every((key) => finite(profile[key]) && profile[key] > 0)
  );
}
export function canSkipFaceMeasurement(regions, profile) {
  if (!validProfile(profile)) return false;
  return (
    regions.length === 2 &&
    ["eye_0", "eye_1"].every((kind) => {
      const found = regions.filter((r) => r.kind === kind);
      const raw = found[0]?.metrics;
      const metrics =
        profile.scoreMode === "denoised-ratio-v1"
          ? raw?.noiseCorrection?.corrected
          : raw;
      const score = metrics?.scales?.[0];
      return (
        found.length === 1 &&
        metrics?.status === "measured" &&
        (profile.scoreMode !== "denoised-ratio-v1" ||
          raw?.noiseCorrection?.version === REFINEMENT_VERSION) &&
        finite(score?.laplacianVariance) &&
        finite(score?.tenengrad) &&
        (["frequency-ratio-v1", "denoised-ratio-v1"].includes(profile.scoreMode)
          ? score.laplacianVariance >= 0 &&
            score.tenengrad > 0 &&
            score.laplacianVariance / score.tenengrad >= profile.eyeRatio * 2
          : score.laplacianVariance >= profile.eyeLaplacian * 2 &&
            score.tenengrad >= profile.eyeTenengrad * 2)
      );
    })
  );
}

// Crops are taken from the original oriented bitmap at 1:1 resolution, not a thumbnail.
export async function measurePortraitRegions(
  plan,
  readPixels,
  { signal, profile, cascade = false, includeMotion = false } = {},
) {
  const faces = [];
  for (const face of plan.faces) {
    const regions = [];
    const crops = cascade
      ? [
          ["eye_0", face.eyes[0]],
          ["eye_1", face.eyes[1]],
          ["face", face.face],
        ]
      : [
          ["face", face.face],
          ["eye_0", face.eyes[0]],
          ["eye_1", face.eyes[1]],
        ];
    let faceSkipped = false;
    for (const [kind, rect] of crops) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (
        kind === "face" &&
        cascade &&
        !plan.issues.length &&
        (profile?.scoreMode !== "denoised-ratio-v1" || face.eyesRefined) &&
        canSkipFaceMeasurement(regions, profile)
      ) {
        faceSkipped = true;
        continue;
      }
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const pixels = await readPixels(rect);
      if (pixels?.width !== rect.width || pixels?.height !== rect.height)
        throw new TypeError("Native crop dimensions changed");
      const metrics = analyzeBlurPixels(pixels, { maxEdge: 1024, signal });
      const denoised = medianDenoise(pixels, { signal });
      metrics.noiseCorrection = {
        version: REFINEMENT_VERSION,
        meanAbsoluteResidual: denoised.meanAbsoluteResidual,
        corrected: analyzeBlurPixels(denoised.image, { maxEdge: 1024, signal }),
      };
      if (includeMotion && kind === "face")
        metrics.faceMotion = measureFaceMotion(denoised.image, { signal });
      regions.push({ kind, rect, metrics });
    }
    faces.push({
      score: face.score,
      eyesRefined: face.eyesRefined === true,
      regions,
      ...(faceSkipped ? { faceSkipped: "sharp_native_eyes" } : {}),
    });
  }
  return {
    algorithmVersion: PORTRAIT_ALGORITHM_VERSION,
    route: plan.route,
    issues: [...plan.issues],
    faces,
  };
}

// Facial texture varies with makeup, lighting and noise. No invented default threshold.
export function classifyPortraitFocus(result, profile) {
  const no = (issue) => ({
    verdict: "inconclusive",
    reasons: [],
    issue,
    experimental: true,
  });
  if (!profile) return no("portrait_thresholds_not_calibrated");
  if (!validProfile(profile))
    throw new TypeError("Explicit positive portrait calibration required");
  if (
    result?.algorithmVersion !== PORTRAIT_ALGORITHM_VERSION ||
    result.route !== "portrait" ||
    !result.faces?.length ||
    result.issues?.length
  )
    return no("portrait_evidence_incomplete");
  let suspect = false;
  for (const face of result.faces) {
    if (profile.scoreMode === "denoised-ratio-v1" && !face.eyesRefined)
      return no("eye_landmarks_unverified");
    if (
      face.faceSkipped === "sharp_native_eyes" &&
      canSkipFaceMeasurement(face.regions, profile)
    )
      continue;
    if (
      face.regions?.length !== 3 ||
      new Set(face.regions.map((r) => r.kind)).size !== 3 ||
      !["face", "eye_0", "eye_1"].every((kind) =>
        face.regions.some((r) => r.kind === kind),
      )
    )
      return no("portrait_evidence_incomplete");
    let allLow = true;
    for (const region of face.regions) {
      const m =
          profile.scoreMode === "denoised-ratio-v1"
            ? region.metrics?.noiseCorrection?.corrected
            : region.metrics,
        score = m?.scales?.[0];
      if (
        m?.status !== "measured" ||
        !score ||
        ![score.laplacianVariance, score.tenengrad].every(
          (v) => finite(v) && v >= 0,
        )
      )
        return no("portrait_evidence_incomplete");
      if (
        profile.scoreMode === "denoised-ratio-v1" &&
        region.metrics?.noiseCorrection?.version !== REFINEMENT_VERSION
      )
        return no("noise_correction_unverified");
      const eye = region.kind !== "face";
      if (
        ["frequency-ratio-v1", "denoised-ratio-v1"].includes(profile.scoreMode)
      ) {
        if (score.tenengrad <= 0) return no("portrait_evidence_incomplete");
        allLow &&=
          score.laplacianVariance / score.tenengrad <
          (eye ? profile.eyeRatio : profile.faceRatio);
      } else {
        allLow &&=
          score.laplacianVariance <
            (eye ? profile.eyeLaplacian : profile.faceLaplacian) &&
          score.tenengrad <
            (eye ? profile.eyeTenengrad : profile.faceTenengrad);
      }
    }
    suspect ||= allLow;
  }
  return {
    verdict: suspect ? "portrait_focus_suspected" : "no_signal",
    reasons: suspect ? ["portrait_focus"] : [],
    experimental: true,
  };
}

