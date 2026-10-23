// Review metadata never changes matching, file selection or file contents.
const EMPTY = Object.freeze({
  status: "unanalysed",
  reasons: Object.freeze([]),
  acknowledged: false,
});
const STATUSES = new Set([
  "unanalysed",
  "analysing",
  "complete",
  "failed",
  "unsupported",
  "inconclusive",
  "cancelled",
]);
export const REVIEW_REASONS = Object.freeze({
  portrait_focus: Object.freeze({
    label: "얼굴·눈 선명도 확인",
    description:
      "원본 해상도의 얼굴·눈 주변에서 선명도 저하가 의심됩니다. 확대해서 직접 확인해 주세요.",
  }),
  image_motion: Object.freeze({
    label: "사진 구역 흔들림 의심",
    description:
      "사진의 여러 구역에서 같은 방향의 번짐 신호가 있습니다. 인물 위치가 확인된 판정은 아니므로 확대해서 확인해 주세요.",
  }),
  motion: Object.freeze({
    label: "흔들림 의심",
    description:
      "얼굴의 여러 구역에서 방향성 번짐 또는 반복 경계 신호가 있습니다. 확대해서 직접 확인해 주세요.",
  }),
  blur: Object.freeze({
    label: "흐림 의심",
    description:
      "선명도가 낮은 것으로 추정됩니다. 확대해서 직접 확인해 주세요.",
  }),
  eyes_closed: Object.freeze({
    label: "눈 감음 의심",
    description:
      "눈이 감긴 것으로 추정됩니다. 표정과 촬영 의도를 함께 확인해 주세요.",
  }),
  similar: Object.freeze({
    label: "유사 사진",
    description: "비슷한 사진이 있습니다. 구도와 표정을 비교해 주세요.",
  }),
});

export function needsPhotoReview(row) {
  return Boolean(
    row.chosen &&
      row.review?.status === "complete" &&
      row.review.reasons.some((reason) =>
        Object.hasOwn(REVIEW_REASONS, reason),
      ) &&
      !row.review.acknowledged,
  );
}

export function needsAttention(row) {
  return Boolean(
    (!row.chosen && row.candidates.length > 0) || needsPhotoReview(row),
  );
}

export function createReviewStore() {
  let records = new WeakMap();
  const read = (file) => (file ? (records.get(file)?.value ?? EMPTY) : EMPTY);
  return {
    read,
    bind(row) {
      Object.defineProperty(row, "review", {
        enumerable: false,
        get: () => read(row.chosen),
      });
      return row;
    },
    begin(file) {
      if (!file || typeof file !== "object")
        throw new TypeError("A read-only file entry is required");
      const token = Object.freeze({});
      records.set(file, {
        token,
        value: Object.freeze({
          status: "analysing",
          reasons: Object.freeze([]),
          acknowledged: false,
        }),
      });
      return token;
    },
    finish(file, token, result) {
      const record = file && records.get(file);
      if (
        !record ||
        record.token !== token ||
        record.value.status !== "analysing"
      )
        return false;
      if (
        !result ||
        !STATUSES.has(result.status) ||
        ![
          "complete",
          "failed",
          "unsupported",
          "inconclusive",
          "cancelled",
        ].includes(result.status)
      )
        throw new TypeError("Invalid review result");
      const reasons =
        result.status === "complete"
          ? [
              ...new Set(
                (Array.isArray(result.reasons) ? result.reasons : []).filter(
                  (reason) =>
                    typeof reason === "string" &&
                    Object.hasOwn(REVIEW_REASONS, reason),
                ),
              ),
            ]
          : [];
      record.value = Object.freeze({
        status: result.status,
        reasons: Object.freeze(reasons),
        acknowledged: false,
      });
      return true;
    },
    acknowledge(file) {
      const record = file && records.get(file);
      if (
        !record ||
        record.value.status !== "complete" ||
        !record.value.reasons.length
      )
        return false;
      record.value = Object.freeze({ ...record.value, acknowledged: true });
      return true;
    },
    clear() {
      records = new WeakMap();
    },
  };
}

export function appendReviewBadge({
  document,
  content,
  row,
  disabled = false,
  onAcknowledge,
  isBusy = () => false,
}) {
  if (!row.chosen) return;
  const review = row.review ?? EMPTY;
  const reasons =
    review.status === "complete"
      ? review.reasons.filter((reason) => Object.hasOwn(REVIEW_REASONS, reason))
      : [];
  const labels = {
    unanalysed: "미분석",
    analysing: "검토 중",
    failed: "분석 실패",
    unsupported: "JPG 검사 미지원",
    inconclusive: "판단 보류",
    cancelled: "검사 취소됨",
  };
  const wrap = document.createElement("div");
  wrap.className = "review-badges";
  const label = document.createElement("span");
  label.className = "review-badge";
  if (review.status !== "complete" || !reasons.length || review.acknowledged) {
    label.textContent =
      review.status === "complete"
        ? review.acknowledged && reasons.length
          ? "검토 확인 완료"
          : "이상 없음"
        : (labels[review.status] ?? "미분석");
    if (review.status === "complete" && !reasons.length)
      label.title = "현재 검사 범위에서 의심 신호가 발견되지 않았습니다. 사진 전체의 품질을 보장하는 판정은 아닙니다.";
    if (review.status === "inconclusive")
      label.title =
        "검사는 완료했지만 판정에 필요한 영역이나 세부 경계가 충분하지 않습니다. 사진을 확대해 직접 확인하세요.";
    wrap.append(label);
  } else {
    const details = document.createElement("details");
    details.className = "review-details";
    const summary = document.createElement("summary");
    summary.className = "review-badge review-warning";
    summary.textContent = reasons
      .map((reason) => REVIEW_REASONS[reason].label)
      .join(" · ");
    const explanation = document.createElement("p");
    explanation.textContent = reasons
      .map((reason) => REVIEW_REASONS[reason].description)
      .join(" ");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "review-confirm";
    confirm.textContent = "확인 완료";
    confirm.setAttribute("aria-label", `${row.item} 사진 검토 확인 완료`);
    confirm.disabled = disabled;
    confirm.addEventListener("click", () => {
      if (!isBusy()) onAcknowledge?.();
    });
    details.append(summary, explanation, confirm);
    wrap.append(details);
  }
  content.append(wrap);
}

