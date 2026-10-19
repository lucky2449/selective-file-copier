import { extension, normalize, stem } from "./core.mjs?v=selected-formats-1";
import { isPhotoFile } from "./photo-pairs.mjs?v=selected-formats-1";
const jpeg = (entry) =>
  [".jpg", ".jpeg", ".jpe"].includes(extension(entry.name));
const key = (entry) => {
  const path = entry.path.normalize("NFC").replace(/\\/g, "/");
  return path.slice(0, path.lastIndexOf("/") + 1) + normalize(stem(entry.name));
};
// Preview candidates never alter search filters, selected rows or output files.
export function createPreviewResolver(files) {
  const groups = new Map();
  for (const entry of files) {
    if (!jpeg(entry)) continue;
    const id = key(entry);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(entry);
  }
  return (entry) => {
    if (!entry) return null;
    if (jpeg(entry)) return entry;
    if (!isPhotoFile(entry)) return null;
    const matches = groups.get(key(entry)) ?? [];
    return matches.length === 1 ? matches[0] : null;
  };
}

// Only a memory-backed, resized JPEG is produced. No filesystem or network writes.
export async function makeThumbnail(file, { window, document }) {
  let decoded, originalUrl;
  try {
    if (typeof window.createImageBitmap === "function") {
      decoded = await window.createImageBitmap(file, {
        resizeWidth: 320,
        resizeQuality: "low",
      });
    } else {
      originalUrl = window.URL.createObjectURL(file);
      decoded = new window.Image();
      decoded.src = originalUrl;
      await decoded.decode();
    }
    const width = decoded.width || decoded.naturalWidth;
    const height = decoded.height || decoded.naturalHeight;
    if (!width || !height) throw new Error("Invalid image");
    const scale = Math.min(1, 320 / width, 320 / height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(decoded, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Preview unavailable")),
        "image/jpeg",
        0.55,
      ),
    );
  } finally {
    decoded?.close?.();
    if (originalUrl) window.URL.revokeObjectURL(originalUrl);
  }
}

export function createPreviewManager({
  window,
  document,
  root,
  decode = makeThumbnail,
}) {
  let items = [],
    queue = [],
    active = 0,
    popup,
    popupImage,
    popupLabel,
    current = null;
  const urls = window.URL;
  function hide() {
    for (const item of items) item.hovered = false;
    current = null;
    if (popup) popup.hidden = true;
    popupImage?.removeAttribute("src");
  }
  function show(item) {
    if (!item.url || item.disposed) return;
    if (!popup) {
      popup = document.createElement("div");
      popup.className = "thumbnail-popup";
      popup.setAttribute("role", "tooltip");
      popupImage = document.createElement("img");
      popupLabel = document.createElement("span");
      popup.append(popupImage, popupLabel);
      document.body.append(popup);
    }
    current = item;
    popupImage.src = item.url;
    popupImage.alt = item.entry.name;
    popupLabel.textContent = item.entry.name;
    popup.hidden = false;
    const rect = item.button.getBoundingClientRect();
    const width = Math.min(240, window.innerWidth - 16);
    popup.style.width = `${width}px`;
    const left =
      rect.right + 10 + width <= window.innerWidth - 8
        ? rect.right + 10
        : rect.left - width - 10;
    popup.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - popup.offsetHeight - 8))}px`;
  }
  function release(item) {
    if (current === item) hide();
    if (item.url) urls.revokeObjectURL(item.url);
    item.url = null;
    item.image?.remove();
    item.image = null;
    item.button.textContent = item.failed ? "!" : "·";
  }
  function pump() {
    while (active < 2 && queue.length) {
      const item = queue.shift();
      item.queued = false;
      if (
        !item.visible ||
        item.disposed ||
        item.url ||
        item.loading ||
        item.failed
      )
        continue;
      active++;
      item.loading = true;
      Promise.resolve()
        .then(() => decode(item.entry.file, { window, document }))
        .then((blob) => {
          if (item.disposed || !item.visible) return;
          item.url = urls.createObjectURL(blob);
          const img = document.createElement("img");
          img.src = item.url;
          img.alt = "";
          item.image = img;
          item.button.textContent = "";
          item.button.append(img);
          if (item.hovered) show(item);
        })
        .catch(() => {
          if (!item.disposed) {
            item.failed = true;
            item.button.textContent = "!";
            item.button.title =
              "미리보기를 읽을 수 없습니다. 파일 선택과 저장은 계속 사용할 수 있습니다.";
          }
        })
        .finally(() => {
          active--;
          item.loading = false;
          pump();
        });
    }
  }
  function enqueue(item) {
    if (
      !item.queued &&
      !item.loading &&
      !item.url &&
      !item.failed &&
      !item.disposed
    ) {
      item.queued = true;
      queue.push(item);
      pump();
    }
  }
  const observer =
    typeof window.IntersectionObserver === "function"
      ? new window.IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const item = entry.target.previewItem;
              if (!item || item.disposed) continue;
              item.visible = entry.isIntersecting;
              if (item.visible) enqueue(item);
              else release(item);
            }
          },
          { root, rootMargin: "48px" },
        )
      : null;
  root?.addEventListener("scroll", hide, { passive: true });
  window.addEventListener?.("resize", hide);
  window.addEventListener?.("scroll", hide, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest?.(".result-thumbnail")) hide();
  });
  const reset = () => {
    observer?.disconnect();
    hide();
    queue = [];
    for (const item of items) {
      item.disposed = true;
      release(item);
      delete item.button.previewItem;
    }
    items = [];
  };
  window.addEventListener?.("pagehide", () => {
    observer?.disconnect();
    hide();
    queue = [];
    for (const item of items) {
      item.visible = false;
      item.queued = false;
      release(item);
    }
  });
  window.addEventListener?.("pageshow", () => {
    for (const item of items)
      if (!item.disposed) observer?.observe(item.button);
  });
  return {
    reset,
    attach(cell, entry) {
      const button = document.createElement(entry ? "button" : "span");
      button.className = "result-thumbnail";
      button.textContent = entry ? "·" : "—";
      button.title = entry ? "JPG 미리보기" : "미리보기 없음";
      if (!entry) {
        cell.append(button);
        return;
      }
      button.type = "button";
      button.setAttribute("aria-label", `${entry.name} 미리보기`);
      const item = { button, entry, visible: false, disposed: false };
      items.push(item);
      button.previewItem = item;
      const enter = () => {
        item.hovered = true;
        item.visible = true;
        enqueue(item);
        show(item);
      };
      const leave = () => {
        item.hovered = false;
        if (current === item) hide();
        if (!observer) {
          item.visible = false;
          release(item);
        }
      };
      button.addEventListener("mouseenter", enter);
      button.addEventListener("mouseleave", leave);
      button.addEventListener("focus", enter);
      button.addEventListener("blur", leave);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        enter();
      });
      cell.append(button);
      observer?.observe(button);
    },
  };
}
