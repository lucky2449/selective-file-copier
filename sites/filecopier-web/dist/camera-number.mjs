// Filename patterns are hints, never proof of camera identity.
// See CAMERA_NUMBER_RULES.md for official sources and supported examples.
const PHOTO_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".jpe",
  ".heic",
  ".heif",
  ".hif",
  ".tif",
  ".tiff",
  ".raw",
  ".cr2",
  ".cr3",
  ".nef",
  ".nrw",
  ".arw",
  ".sr2",
  ".srf",
  ".raf",
  ".rw2",
  ".rwl",
  ".orf",
  ".pef",
  ".dng",
  ".3fr",
  ".fff",
  ".x3f",
  ".gpr",
  ".iiq",
  ".srw",
  ".mrw",
]);
const STANDARD =
  /^(?:IMG_|_MG_|DSC_|_DSC|DSCF|_DSF|DSCN|RSCN|SSCN|FSCN|IMGP|_IGP|_IMG|SDIM|_SDI|FP|GOPR|RIMG|_RIM|B)(\d+)$/i;
export function recognizeCameraNumber(base, ext) {
  const result = { hints: [], ignoreTrailing: false };
  if (!PHOTO_EXTENSIONS.has(ext.toLowerCase())) return result;
  const add = (value, reason) => {
    if (!/^\d+$/.test(value) || !/[1-9]/.test(value)) return;
    const id = value.replace(/^0+(?=\d)/, "");
    if (!result.hints.some((hint) => hint.id === id))
      result.hints.push({ id, reason });
  };
  let match;
  // DJI date/time + sequence + optional lens/custom suffix. Suffix digits
  // (e.g. Waypoint1) must not be used as the photograph's sequence number.
  if (
    (match = base.match(
      /^DJI_\d{13,14}_(\d{3,4})(?:_[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*)?$/i,
    ))
  ) {
    add(match[1], "DJI 날짜 뒤 촬영 번호 추정");
    result.ignoreTrailing = true;
    return result;
  }
  if (/^DJI_\d{13,14}$/i.test(base)) {
    result.ignoreTrailing = true; // A timestamp alone is not a frame number.
    return result;
  }
  // Only known camera originals receive edit/collision suffix interpretation.
  const edited = base.match(
    /^(.*?)(?:[_-](?:\d+|edit|edited|copy)| \(\d+\))$/i,
  );
  if (edited && STANDARD.test(edited[1])) {
    add(edited[1].match(/(\d+)$/)[1], "편집·중복본의 원래 번호 추정");
    result.ignoreTrailing = true;
    return result;
  }
  // These standard prefixes already use the entire trailing sequence, including
  // longer Sony/Sigma/Hasselblad counters. Do not truncate them to four digits.
  if (
    STANDARD.test(base) ||
    /^DSC\d+$/i.test(base) ||
    /^DJI_\d{4}$/i.test(base)
  )
    return result;
  if ((match = base.match(/^[PL_]([1-9]\d{2})(\d{4})$/i)))
    add(match[2], "Panasonic·Leica 폴더 번호 제외 추정");
  if ((match = base.match(/^[P_]([1-9ABC])(\d{2})(\d{4})$/i))) {
    const month = parseInt(match[1], 16),
      day = Number(match[2]);
    if (
      day >= 1 &&
      day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    )
      add(match[3], "OM·Olympus 월일 제외 추정");
  }
  if ((match = base.match(/^[R_]\d{3}(\d{4})$/i)))
    add(match[1], "Ricoh 계열 끝 4자리 후보");
  if (result.hints.length) return result;
  // Prefix lengths vary. JPEG/DNG names can fit more than one rule, so keep
  // every plausible interpretation and require selection in the caller.
  if (
    ![".arw", ".sr2", ".srf"].includes(ext.toLowerCase()) &&
    (match = base.match(/^(?:[A-Z][A-Z0-9_]{3}|_[A-Z0-9]{3})(\d{4})$/i))
  )
    add(match[1], "Canon·Nikon·Fujifilm·Pentax 4자리 접두사 형식 추정");
  if (
    [
      ".jpg",
      ".jpeg",
      ".heic",
      ".heif",
      ".hif",
      ".tif",
      ".tiff",
      ".dng",
      ".arw",
      ".sr2",
      ".srf",
    ].includes(ext.toLowerCase()) &&
    (match = base.match(/^[A-Z][A-Z0-9_]{2}(\d{5})$/i))
  )
    add(match[1], "Sony 3자리 접두사·5자리 번호 형식 추정");
  return result;
}
