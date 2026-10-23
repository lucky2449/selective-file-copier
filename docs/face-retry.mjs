// Bounded affine retry views. No original pixel mutation or identity recognition.
const valid = (b) =>
  b &&
  [b.x, b.y, b.width, b.height].every(Number.isFinite) &&
  b.x >= 0 &&
  b.y >= 0 &&
  b.width > 0 &&
  b.height > 0 &&
  b.x + b.width <= 1.001 &&
  b.y + b.height <= 1.001;
export function planFaceRetry({ width, height }, detections) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 40_000_000 ||
    !Array.isArray(detections) ||
    detections.length > 256
  )
    throw new TypeError("Bounded retry input required");
  const frames = [];
  const add = (cx, cy, side, angle) => frames.push({ cx, cy, side, angle });
  for (const face of [...detections]
    .filter((f) => valid(f?.box) && Number.isFinite(f.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)) {
    const b = face.box;
    for (const degrees of [-45, 45, -90, 90])
      add(
        (b.x + b.width / 2) * width,
        (b.y + b.height / 2) * height,
        Math.max(128, Math.max(b.width * width, b.height * height) * 1.8),
        (degrees * Math.PI) / 180,
      );
  }
  for (const degrees of [-90, 90, -45, 45])
    add(
      width / 2,
      height / 2,
      Math.max(width, height),
      (degrees * Math.PI) / 180,
    );
  return frames.slice(0, 12);
}
export function mapRetryDetection(face, frame, { width, height }) {
  if (
    !frame ||
    ![frame.cx, frame.cy, frame.side, frame.angle, width, height].every(
      Number.isFinite,
    ) ||
    frame.side <= 0 ||
    width <= 0 ||
    height <= 0 ||
    !valid(face?.box) ||
    !Number.isFinite(face.score) ||
    face.score < 0 ||
    face.score > 1
  )
    return null;
  const point = (p) => {
    const x = (p.x - 0.5) * frame.side,
      y = (p.y - 0.5) * frame.side;
    return {
      x:
        (frame.cx + Math.cos(frame.angle) * x - Math.sin(frame.angle) * y) /
        width,
      y:
        (frame.cy + Math.sin(frame.angle) * x + Math.cos(frame.angle) * y) /
        height,
    };
  };
  const b = face.box,
    corners = [
      point({ x: b.x, y: b.y }),
      point({ x: b.x + b.width, y: b.y }),
      point({ x: b.x, y: b.y + b.height }),
      point({ x: b.x + b.width, y: b.y + b.height }),
    ];
  const left = Math.min(...corners.map((p) => p.x)),
    top = Math.min(...corners.map((p) => p.y)),
    right = Math.max(...corners.map((p) => p.x)),
    bottom = Math.max(...corners.map((p) => p.y));
  const box = { x: left, y: top, width: right - left, height: bottom - top };
  if (!valid(box)) return null;
  const eyes = (face.eyes ?? [])
    .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    .slice(0, 2)
    .map(point);
  return { score: face.score, box, eyes, recovered: true };
}
export function planImageFallback({ width, height }) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 40_000_000
  )
    throw new TypeError("Bounded fallback dimensions required");
  return [
    { x: 0, y: 0, width, height },
    ...[
      [0, 0],
      [0.5, 0],
      [0, 0.5],
      [0.5, 0.5],
    ].map(([x, y]) => ({
      x: Math.floor(x * width),
      y: Math.floor(y * height),
      width: Math.floor(width / 2),
      height: Math.floor(height / 2),
    })),
  ].filter((r) => Math.min(r.width, r.height) >= 64);
}
export function decideImageFallback(regions) {
  const quarters = regions
    .slice(1)
    .filter(
      (r) =>
        r?.decision?.verdict === "motion_suspected" &&
        Number.isFinite(r.decision.directionDegrees),
    );
  const corroborated = quarters.some((a, i) =>
    quarters
      .slice(i + 1)
      .some((b) => a.decision.directionDegrees === b.decision.directionDegrees),
  );
  if (
    !corroborated &&
    regions.length === 5 &&
    regions.every((r) => r?.decision?.verdict === "no_signal") &&
    regions
      .slice(1)
      .filter((r) => r.assessment?.sufficient && r.assessment?.sharpDetail)
      .length >= 2
  )
    return {
      verdict: "no_signal",
      reasons: [],
      scope: "image_regions_not_confirmed_person",
      experimental: true,
    };
  return corroborated
    ? {
        verdict: "motion_suspected",
        reasons: ["image_motion"],
        scope: "image_regions_not_confirmed_person",
        experimental: true,
      }
    : {
        verdict: "inconclusive",
        reasons: [],
        issue: "face_unavailable_image_regions_insufficient",
        experimental: true,
      };
}

// Completion means the enabled motion checks ran, not a guarantee of sharp focus.
export function resolveReviewDecision(decision, faceMotion = []) {
  if (decision?.verdict !== "inconclusive" || !faceMotion.length)
    return decision;
  if (
    faceMotion.every(
      (face) =>
        face?.decision?.verdict === "no_signal" &&
        face.assessment?.sufficient &&
        face.assessment?.sharpDetail,
    )
  )
    return {
      verdict: "no_signal",
      reasons: [],
      scope: "motion_checks_only",
      experimental: true,
    };
  return decision;
}
