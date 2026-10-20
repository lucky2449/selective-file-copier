// Streaming ZIP (stored entries, UTF-8, CRC32). Files are never uploaded.
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const updateCRC = (crc, bytes) => {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc;
};
function record(size, fields) {
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  for (const [offset, value, width = 4] of fields)
    width === 2
      ? view.setUint16(offset, value, true)
      : view.setUint32(offset, value >>> 0, true);
  return bytes;
}
function dosDate(time) {
  const date = new Date(time || Date.now());
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return [
    (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      (date.getSeconds() >> 1),
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  ];
}
export async function writeZip(
  entries,
  sink,
  { cancelled = () => false, progress = () => {} } = {},
) {
  if (entries.length > 65535)
    throw new Error("ZIP 한 개에는 최대 65,535개 파일을 저장할 수 있습니다.");
  const central = [];
  let offset = 0;
  const check = () => {
    if (cancelled())
      throw new DOMException("작업을 취소했습니다.", "AbortError");
  };
  const write = async (bytes) => {
    check();
    if (offset + bytes.byteLength > 0xffffffff)
      throw new Error(
        "ZIP 크기가 4GB를 넘습니다. 저장 폴더를 선택해 직접 복사하세요.",
      );
    await sink.write(bytes);
    offset += bytes.byteLength;
  };
  for (let i = 0; i < entries.length; i++) {
    check();
    const { name, file } = entries[i];
    const expectedSize = file.size;
    const mismatch = () =>
      Object.assign(
        new Error(
          "원본 파일 크기가 달라 ZIP 생성을 중단했습니다. 원본을 다시 선택하세요.",
        ),
        { code: "SIZE_MISMATCH" },
      );
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
      throw mismatch();
    if (expectedSize > 0xffffffff)
      throw new Error("4GB가 넘는 파일은 저장 폴더로 직접 복사하세요.");
    const filename = encoder.encode(name),
      start = offset,
      [time, date] = dosDate(file.lastModified);
    if (filename.length > 65535) throw new Error("파일 이름이 너무 깁니다.");
    await write(
      record(30, [
        [0, 0x04034b50],
        [4, 20, 2],
        [6, 0x808, 2],
        [10, time, 2],
        [12, date, 2],
        [26, filename.length, 2],
      ]),
    );
    await write(filename);
    let crc = 0xffffffff,
      size = 0;
    const reader = file.stream().getReader();
    try {
      while (true) {
        check();
        const { done, value } = await reader.read();
        if (done) break;
        // Reject the overflowing chunk before it reaches the output.
        if (value.byteLength > expectedSize - size) throw mismatch();
        crc = updateCRC(crc, value);
        size += value.byteLength;
        await write(value);
        progress(i, entries.length, size, expectedSize);
      }
      // Never finalize an entry or start the next file after a short read.
      if (size !== expectedSize) throw mismatch();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    await write(
      record(16, [
        [0, 0x08074b50],
        [4, crc],
        [8, size],
        [12, size],
      ]),
    );
    central.push(
      record(46, [
        [0, 0x02014b50],
        [4, 20, 2],
        [6, 20, 2],
        [8, 0x808, 2],
        [12, time, 2],
        [14, date, 2],
        [16, crc],
        [20, size],
        [24, size],
        [28, filename.length, 2],
        [42, start],
      ]),
      filename,
    );
    progress(i + 1, entries.length, 0, 0);
  }
  const start = offset;
  for (const bytes of central) await write(bytes);
  await write(
    record(22, [
      [0, 0x06054b50],
      [8, entries.length, 2],
      [10, entries.length, 2],
      [12, offset - start],
      [16, start],
    ]),
  );
}
