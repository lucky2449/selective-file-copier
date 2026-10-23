// Pure geometry/pixel helpers. No files, network, writes or identity recognition.
const finite = Number.isFinite;
export const REFINEMENT_VERSION = "eyelid-median-v2";
export function refineEyeContours(detection, contours, { width, height }) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 40_000_000
  )
    return null;
  const box = detection?.box;
  if (
    !box ||
    ![box.x, box.y, box.width, box.height].every(finite) ||
    box.x < 0 ||
    box.y < 0 ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x + box.width > 1.001 ||
    box.y + box.height > 1.001 ||
    !Array.isArray(contours) ||
    contours.length !== 2
  )
    return null;
  const eyes = [],
    eyeSides = [];
  for (const points of contours) {
    if (
      !Array.isArray(points) ||
      points.length < 6 ||
      points.length > 32 ||
      points.some(
        (p) =>
          !finite(p?.x) ||
          !finite(p?.y) ||
          p.x < 0 ||
          p.y < 0 ||
          p.x > 1 ||
          p.y > 1,
      )
    )
      return null;
    const xs = points.map((p) => p.x),
      ys = points.map((p) => p.y);
    const left = Math.min(...xs),
      right = Math.max(...xs),
      top = Math.min(...ys),
      bottom = Math.max(...ys);
    const w = (right - left) * width,
      h = (bottom - top) * height;
    if (w < 12 || h < 2 || w > box.width * width * 0.7 || h > w * 1.2)
      return null;
    const eye = { x: (left + right) / 2, y: (top + bottom) / 2 };
    if (
      eye.x < box.x ||
      eye.x > box.x + box.width ||
      eye.y < box.y ||
      eye.y > box.y + box.height
    )
      return null;
    eyes.push(eye);
    eyeSides.push(
      Math.round(Math.max(64, Math.min(256, Math.hypot(w, h) * 1.4))),
    );
  }
  const distance = Math.hypot(
    (eyes[0].x - eyes[1].x) * width,
    (eyes[0].y - eyes[1].y) * height,
  );
  if (
    distance < 60 ||
    distance > box.width * width * 0.95 ||
    Math.max(...eyeSides) > distance * 1.2
  )
    return null;
  return { ...detection, eyes, eyeSides, eyesRefined: true };
}

// Median filtering suppresses isolated pixel noise while keeping edges. It only
// changes a new RGBA buffer. Scores must be calibrated for this preprocessing.
export function medianDenoise(image, { signal } = {}) {
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
    throw new TypeError("Bounded native RGBA crop required");
  const gray = new Float32Array(width * height),
    out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < gray.length; i++) {
    if (data[i * 4 + 3] !== 255) throw new TypeError("Opaque crop required");
    gray[i] =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const values = new Float32Array(9);
  const indices = new Uint32Array(9);
  let residual = 0;
  for (let y = 0; y < height; y++) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const index =
            Math.max(0, Math.min(height - 1, y + dy)) * width +
            Math.max(0, Math.min(width - 1, x + dx));
          values[n] = gray[index];
          indices[n++] = index;
        }
      for (let j = 1; j < 9; j++) {
        const value = values[j],
          index = indices[j];
        let k = j - 1;
        while (k >= 0 && values[k] > value) {
          values[k + 1] = values[k];
          indices[k + 1] = indices[k];
          k--;
        }
        values[k + 1] = value;
        indices[k + 1] = index;
      }
      const i = y * width + x,
        v = values[4];
      residual += Math.abs(gray[i] - v);
      // Copy the median-luminance pixel's original RGB. Rounding luminance to
      // 8-bit grayscale would introduce a new noise floor in dark regions.
      const source = indices[4] * 4;
      out[i * 4] = data[source];
      out[i * 4 + 1] = data[source + 1];
      out[i * 4 + 2] = data[source + 2];
      out[i * 4 + 3] = 255;
    }
  }
  return {
    image: { width, height, data: out },
    meanAbsoluteResidual: residual / gray.length,
    version: REFINEMENT_VERSION,
  };
}

// Motion can use a confident face box even when precise eye geometry fails.
export function planFaceMotionCrops({ width, height }, detections) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 40_000_000 ||
    !Array.isArray(detections) ||
    detections.length > 256
  )
    throw new TypeError("Bounded face detections required");
  const crops = [];
  for (const face of [...detections].sort(
    (a, b) => (b?.score ?? 0) - (a?.score ?? 0),
  )) {
    const b = face?.box;
    if (
      !b ||
      !Number.isFinite(face.score) ||
      face.score < 0.6 ||
      face.score > 1 ||
      ![b.x, b.y, b.width, b.height].every(Number.isFinite) ||
      b.x < 0 ||
      b.y < 0 ||
      b.width <= 0 ||
      b.height <= 0 ||
      b.x + b.width > 1.001 ||
      b.y + b.height > 1.001
    )
      continue;
    const side = Math.floor(Math.min(768, b.width * width, b.height * height));
    if (side < 128) continue;
    const rect = {
      x: Math.max(
        0,
        Math.min(
          width - side,
          Math.round((b.x + b.width / 2) * width - side / 2),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          height - side,
          Math.round((b.y + b.height / 2) * height - side / 2),
        ),
      ),
      width: side,
      height: side,
    };
    if (
      crops.some(
        (c) =>
          Math.abs(c.rect.x - rect.x) < side * 0.25 &&
          Math.abs(c.rect.y - rect.y) < side * 0.25 &&
          Math.abs(c.rect.width - side) < side * 0.25,
      )
    )
      continue;
    crops.push({ rect, score: face.score });
    if (crops.length === 12) break;
  }
  return crops;
}
