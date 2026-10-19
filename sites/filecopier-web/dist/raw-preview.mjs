// Bounded, read-only extraction of contiguous baseline/progressive JPEG previews.
// This deliberately does not decode RAW sensor data or claim all RAW support.
export const RAW_SCAN_LIMIT = 32 * 1024 * 1024;
const JPEG_LIMIT = 12 * 1024 * 1024;

function jpegEnd(bytes, start) {
  const limit = Math.min(bytes.length, start + JPEG_LIMIT);
  let p = start + 2,
    frame = false,
    scan = false,
    entropy = false;
  while (p < limit) {
    if (entropy) {
      while (p < limit && bytes[p] !== 255) p++;
    }
    if (bytes[p++] !== 255) return 0;
    while (p < limit && bytes[p] === 255) p++;
    const marker = bytes[p++];
    if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)))
      continue;
    if (marker === 0xd9) return frame && scan ? p : 0;
    entropy = false;
    if (!marker || marker === 0xd8 || p + 2 > limit) return 0;
    const size = bytes[p] * 256 + bytes[p + 1];
    if (size < 2 || p + size > limit) return 0;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      // Reject lossless RAW JPEG and oversized images before browser decoding.
      if (![0xc0, 0xc2].includes(marker) || size < 8 || bytes[p + 2] !== 8)
        return 0;
      const h = bytes[p + 3] * 256 + bytes[p + 4];
      const w = bytes[p + 5] * 256 + bytes[p + 6];
      if (!h || !w || w * h > 40_000_000) return 0;
      frame = true;
    }
    if (marker === 0xda) {
      if (!frame || size < 6) return 0;
      scan = entropy = true;
    }
    p += size;
  }
  return 0;
}

export async function extractRawPreview(file) {
  const bytes = new Uint8Array(
    await file.slice(0, RAW_SCAN_LIMIT).arrayBuffer(),
  );
  let attempts = 0;
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 255 || bytes[i + 1] !== 0xd8 || bytes[i + 2] !== 255)
      continue;
    if (++attempts > 64) break;
    const end = jpegEnd(bytes, i);
    if (end) return new Blob([bytes.subarray(i, end)], { type: "image/jpeg" });
  }
  return null;
}
