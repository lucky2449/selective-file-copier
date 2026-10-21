import LibRawModule from "./vendor/libraw-nothread-1.6.0-1/libraw.js";
import { RAW_CONVERT_LIMIT, RAW_PIXEL_LIMIT } from "./raw-convert.mjs?v=raw-compat-1";

// Dedicated to exactly one input. Main thread terminates us on leave/timeout.
self.onmessage = async ({ data: { file } }) => {
  let raw;
  try {
    if (!(file instanceof Blob) || !file.size || file.size > RAW_CONVERT_LIMIT)
      throw Error();
    const module = await LibRawModule({ print() {}, printErr() {} });
    raw = new module.LibRaw();
    const bytes = new Uint8Array(await file.arrayBuffer());
    raw.open(bytes, {
      halfSize: true,
      outputBps: 8,
      outputColor: 1,
      useCameraWb: true,
      userQual: 0,
      userFlip: -1,
    });
    const meta = raw.metadata(false);
    if (
      ![meta.raw_width, meta.raw_height, meta.width, meta.height].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      ) ||
      meta.raw_width * meta.raw_height > RAW_PIXEL_LIMIT
    )
      throw Error();
    const image = raw.imageData();
    const { width, height, colors, bits, data } = image ?? {};
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width * height > RAW_PIXEL_LIMIT ||
      colors !== 3 ||
      bits !== 8 ||
      !(data instanceof Uint8Array) ||
      data.length !== width * height * 3
    )
      throw Error();
    // Nearest-neighbour downsample directly into the tiny canvas. No full RGBA copy.
    const scale = Math.min(1, 320 / width, 320 / height);
    const w = Math.max(1, Math.round(width * scale)),
      h = Math.max(1, Math.round(height * scale));
    const canvas = new OffscreenCanvas(w, h),
      ctx = canvas.getContext("2d");
    if (!ctx) throw Error();
    const pixels = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const src =
          (Math.min(height - 1, Math.floor(y / scale)) * width +
            Math.min(width - 1, Math.floor(x / scale))) *
          3;
        const dst = (y * w + x) * 4;
        pixels.data[dst] = data[src];
        pixels.data[dst + 1] = data[src + 1];
        pixels.data[dst + 2] = data[src + 2];
        pixels.data[dst + 3] = 255;
      }
    ctx.putImageData(pixels, 0, 0);
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.55,
    });
    self.postMessage({ blob });
  } catch {
    self.postMessage({ error: "RAW_PREVIEW_UNAVAILABLE" });
  } finally {
    raw?.delete();
  }
};
