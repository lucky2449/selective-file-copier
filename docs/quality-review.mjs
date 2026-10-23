import { FACE_MOTION_PROFILE } from "./face-motion-profile.mjs?v=face-motion-1";
import { extension } from "./core.mjs?v=selected-formats-1";
// Only original JPEGs are analysed. RAW previews/conversions are not equivalent evidence.
export function qualityStatus(result) {
  const decision = result?.decision;
  if (
    ["portrait_focus_suspected", "motion_suspected"].includes(decision?.verdict)
  )
    return { status: "complete", reasons: decision.reasons };
  if (decision?.verdict === "no_signal")
    return { status: "complete", reasons: [] };
  return { status: "inconclusive", reasons: [] };
}
export async function reviewPhotos({
  entries,
  reviewer,
  store,
  signal,
  onProgress = () => {},
}) {
  const unique = [...new Set(entries)];
  const totals = {
    complete: 0,
    inconclusive: 0,
    unsupported: 0,
    failed: 0,
    cancelled: 0,
  };
  for (let i = 0; i < unique.length; i++) {
    if (signal?.aborted) break;
    const entry = unique[i],
      token = store.begin(entry);
    let outcome;
    try {
      if (![".jpg", ".jpeg", ".jpe"].includes(extension(entry.name)))
        outcome = { status: "unsupported", reasons: [] };
      else
        outcome = qualityStatus(
          await reviewer.analyze(entry.file, {
            signal,
            motionProfile: FACE_MOTION_PROFILE,
          }),
        );
    } catch (error) {
      outcome = {
        status: error.name === "AbortError" ? "cancelled" : "failed",
        reasons: [],
      };
    }
    if (store.finish(entry, token, outcome)) totals[outcome.status]++;
    onProgress(i + 1, unique.length, totals);
    if (signal?.aborted) break;
  }
  return totals;
}
