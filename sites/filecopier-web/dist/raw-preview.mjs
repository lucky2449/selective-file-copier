import { orientedPreview } from "./preview-orientation.mjs?v=orientation-1";
// Bounded, read-only extraction of contiguous baseline/progressive JPEG previews.
// This deliberately does not decode RAW sensor data or claim all RAW support.
export const RAW_SCAN_LIMIT = 32 * 1024 * 1024;
const JPEG_LIMIT = 12 * 1024 * 1024;
const MAX_PREVIEW_RANGES = 8;

// Only documented container offsets; never follow MakerNote/vendor pointers blindly.
// TIFF JPEGInterchangeFormat/SubIFDs, Panasonic JpgFromRaw, Fuji RAF header.
function previewRanges(bytes, fileSize) {
  const ranges = [];
  const add = (start, length) => {
    if (
      ranges.length >= MAX_PREVIEW_RANGES ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      start < 8 ||
      length < 4 ||
      length > JPEG_LIMIT ||
      start > fileSize - length ||
      ranges.some(([s, n]) => s === start && n === length)
    )
      return;
    ranges.push([start, length]);
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 92 &&
    String.fromCharCode(...bytes.subarray(0, 16)) === "FUJIFILMCCD-RAW "
  ) {
    add(view.getUint32(84), view.getUint32(88));
    return ranges;
  }
  if (bytes.length < 8) return ranges;
  const little = bytes[0] === 73 && bytes[1] === 73;
  if (!little && !(bytes[0] === 77 && bytes[1] === 77)) return ranges;
  const u16 = (p) => view.getUint16(p, little),
    u32 = (p) => view.getUint32(p, little);
  if (![42, 85, 0x4f52, 0x5352].includes(u16(2))) return ranges;
  const queue = [u32(4)],
    visited = new Set();
  while (
    queue.length &&
    visited.size < 32 &&
    ranges.length < MAX_PREVIEW_RANGES
  ) {
    const offset = queue.shift();
    if (visited.has(offset) || offset < 8 || offset + 2 > bytes.length)
      continue;
    visited.add(offset);
    const count = u16(offset),
      end = offset + 2 + count * 12;
    if (count > 4096 || end + 4 > bytes.length) continue;
    let jpegOffset, jpegLength;
    for (let i = 0; i < count; i++) {
      const p = offset + 2 + i * 12,
        tag = u16(p),
        type = u16(p + 2),
        n = u32(p + 4);
      const scalar =
        n === 1
          ? type === 3
            ? u16(p + 8)
            : type === 4
              ? u32(p + 8)
              : null
          : null;
      if (tag === 0x201 && scalar !== null) jpegOffset = scalar;
      if (tag === 0x202 && scalar !== null) jpegLength = scalar;
      if (u16(2) === 85 && tag === 0x2e && [1, 7].includes(type) && n > 4)
        add(u32(p + 8), n);
      if (tag === 0x14a && type === 4 && n > 0 && n <= 16) {
        if (n === 1) queue.push(u32(p + 8));
        else {
          const at = u32(p + 8);
          if (at >= 8 && at + n * 4 <= bytes.length)
            for (let j = 0; j < n; j++) queue.push(u32(at + j * 4));
        }
      }
    }
    add(jpegOffset, jpegLength);
    const next = u32(end);
    if (next) queue.push(next);
  }
  return ranges;
}

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
  // A preview can sit beyond the bounded scan (large NEF/ARW/DNG/RAF, etc.).
  // Read at most eight validated JPEG ranges, one at a time, never the whole RAW.
  for (const [start, length] of previewRanges(
    bytes,
    file.size ?? bytes.length,
  )) {
    try {
      const candidate =
        start + length <= bytes.length
          ? bytes.subarray(start, start + length)
          : new Uint8Array(
              await file.slice(start, start + length).arrayBuffer(),
            );
      if (candidate[0] !== 255 || candidate[1] !== 216) continue;
      const end = jpegEnd(candidate, 0);
      if (end) return orientedPreview(bytes, candidate.subarray(0, end));
    } catch {
      // A damaged/unreadable preview range must not hide a valid scanned JPEG.
    }
  }
  let attempts = 0;
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 255 || bytes[i + 1] !== 0xd8 || bytes[i + 2] !== 255)
      continue;
    if (++attempts > 64) break;
    const end = jpegEnd(bytes, i);
    if (end) return orientedPreview(bytes, bytes.subarray(i, end));
  }
  return null;
}
