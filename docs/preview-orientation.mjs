// Read only the primary image's orientation. Never change the source metadata.
export function tiffOrientation(bytes, start = 0, end = bytes.length) {
  if (start < 0 || end > bytes.length || start + 8 > end) return null;
  const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  if (!little && !(bytes[start] === 0x4d && bytes[start + 1] === 0x4d))
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p) => view.getUint16(p, little),
    u32 = (p) => view.getUint32(p, little);
  // TIFF, Panasonic RW2, Olympus ORF (IFD layout is compatible).
  if (![42, 85, 0x4f52, 0x5352].includes(u16(start + 2))) return null;
  const offset = u32(start + 4);
  if (offset < 8 || offset > end - start - 2) return null;
  const ifd = start + offset,
    count = u16(ifd);
  if (count > 4096 || ifd + 2 + count * 12 > end) return null;
  for (let i = 0; i < count; i++) {
    const p = ifd + 2 + i * 12;
    if (u16(p) !== 0x112 || u16(p + 2) !== 3 || u32(p + 4) !== 1) continue;
    const orientation = u16(p + 8);
    if (orientation >= 1 && orientation <= 8) return orientation;
  }
  return null;
}

export function rawOrientation(bytes) {
  const direct = tiffOrientation(bytes);
  if (direct !== null) return direct;
  // Canon CR3: CMT1 stores the primary TIFF IFD. Do not pick unrelated JPEG EXIF.
  if (
    bytes.length < 12 ||
    String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp"
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let p = 12; p + 12 <= Math.min(bytes.length, 1024 * 1024); p++) {
    if (
      bytes[p] !== 67 ||
      bytes[p + 1] !== 77 ||
      bytes[p + 2] !== 84 ||
      bytes[p + 3] !== 49
    )
      continue;
    const size = view.getUint32(p - 4);
    if (size < 16 || size > bytes.length - (p - 4)) continue;
    const orientation = tiffOrientation(bytes, p + 4, p - 4 + size);
    if (orientation !== null) return orientation;
  }
  return null;
}

export function jpegOrientation(bytes) {
  if (bytes[0] !== 255 || bytes[1] !== 216) return null;
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p++] !== 255) return null;
    while (bytes[p] === 255) p++;
    const marker = bytes[p++];
    if (marker === 0xda || marker === 0xd9) return null;
    const size = bytes[p] * 256 + bytes[p + 1];
    if (size < 2 || p + size > bytes.length) return null;
    if (
      marker === 0xe1 &&
      size >= 16 &&
      String.fromCharCode(...bytes.subarray(p + 2, p + 8)) === "Exif\0\0"
    ) {
      const orientation = tiffOrientation(bytes, p + 8, p + size);
      if (orientation !== null) return orientation;
    }
    p += size;
  }
  return null;
}

export function orientedPreview(rawBytes, jpegBytes) {
  const orientation =
    jpegOrientation(jpegBytes) === null ? rawOrientation(rawBytes) : null;
  if (orientation === null || orientation === 1)
    return new Blob([jpegBytes], { type: "image/jpeg" });
  // Supply missing EXIF to the memory-only JPEG. Browser applies it exactly once.
  const exif = new Uint8Array([
    255,
    225,
    0,
    34,
    69,
    120,
    105,
    102,
    0,
    0,
    73,
    73,
    42,
    0,
    8,
    0,
    0,
    0,
    1,
    0,
    18,
    1,
    3,
    0,
    1,
    0,
    0,
    0,
    orientation,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  return new Blob([jpegBytes.subarray(0, 2), exif, jpegBytes.subarray(2)], {
    type: "image/jpeg",
  });
}
