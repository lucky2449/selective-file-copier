import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  classifyPortraitFocus,
  PORTRAIT_ALGORITHM_VERSION,
} from "../sites/filecopier-web/dist/portrait-analysis.mjs";
const root = resolve(
  process.argv[2] ?? ".local/portrait-development/validation",
);
const manifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8"),
);
const measurements = JSON.parse(
  await readFile(join(root, "measurements.json"), "utf8"),
);
try {
  const extraManifest = JSON.parse(
    await readFile(join(root, "stress-manifest.json"), "utf8"),
  );
  const extraMeasurements = JSON.parse(
    await readFile(join(root, "stress-measurements.json"), "utf8"),
  );
  manifest.push(...extraManifest);
  measurements.push(...extraMeasurements);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const map = new Map(measurements.map((row) => [row.name, row]));
const rows = manifest.map((meta) => ({ ...meta, ...map.get(meta.name) }));
if (rows.some((row) => !row.result || row.error))
  throw Error("Missing or failed measurement");
const trainIds = new Set(
  rows.filter((r) => r.split === "train").map((r) => r.sourceId),
);
if (rows.some((r) => r.split === "holdout" && trainIds.has(r.sourceId)))
  throw Error("Source leakage");
const reference = new Set(["reference", "jpeg65"]),
  positives = new Set(["blur2", "blur3"]);
const corrected = process.argv.includes("--denoised");
const ratio = (r) => {
  const s = (corrected ? r.metrics.noiseCorrection.corrected : r.metrics)
    .scales[0];
  return s.laplacianVariance / s.tenengrad;
};
const thresholds = {};
for (const kind of ["face", "eye"]) {
  const collect = (types) =>
    rows
      .filter(
        (r) =>
          r.split === "train" &&
          types.has(r.kind) &&
          r.result.route === "portrait" &&
          !r.result.issues.length,
      )
      .flatMap((r) =>
        r.result.faces.flatMap((f) =>
          f.regions
            .filter((v) =>
              kind === "face" ? v.kind === "face" : v.kind.startsWith("eye_"),
            )
            .map(ratio),
        ),
      );
  const lowReference = Math.min(...collect(reference)),
    highBlur = Math.max(...collect(positives));
  if (
    !Number.isFinite(lowReference) ||
    !Number.isFinite(highBlur) ||
    lowReference <= highBlur
  )
    throw Error("Training classes overlap: " + kind);
  thresholds[kind] = {
    lowReference,
    highBlur,
    threshold: Math.sqrt(lowReference * highBlur),
  };
}
const candidate = {
  algorithmVersion: PORTRAIT_ALGORITHM_VERSION,
  scoreMode: corrected ? "denoised-ratio-v1" : "frequency-ratio-v1",
  faceRatio: thresholds.face.threshold,
  eyeRatio: thresholds.eye.threshold,
};
const baseline = {
  algorithmVersion: PORTRAIT_ALGORITHM_VERSION,
  faceLaplacian: 10,
  faceTenengrad: 10,
  eyeLaplacian: 10,
  eyeTenengrad: 10,
};
function evaluate(profile) {
  const detail = rows.map((row) => ({
    name: row.name,
    sourceId: row.sourceId,
    split: row.split,
    kind: row.kind,
    issues: row.result.issues,
    decision: classifyPortraitFocus(row.result, profile),
  }));
  const groups = [];
  for (const split of ["train", "holdout"])
    for (const [name, kinds] of [
      ["reference_and_jpeg65", reference],
      ["controlled_blur_2_and_3", positives],
      ["mild_blur", new Set(["mild075", "mild125"])],
      ["dark_reference", new Set(["dark50"])],
      ["blur_with_noise", new Set(["blur2noise8"])],
    ]) {
      const selected = detail.filter(
        (r) => r.split === split && kinds.has(r.kind),
      );
      groups.push({
        split,
        group: name,
        total: selected.length,
        suspected: selected.filter(
          (r) => r.decision.verdict === "portrait_focus_suspected",
        ).length,
        noSignal: selected.filter((r) => r.decision.verdict === "no_signal")
          .length,
        inconclusive: selected.filter(
          (r) => r.decision.verdict === "inconclusive",
        ).length,
      });
    }
  return { profile, groups, detail };
}
const report = {
  sourceCount:
    trainIds.size +
    new Set(rows.filter((r) => r.split === "holdout").map((r) => r.sourceId))
      .size,
  variants: rows.length,
  thresholds,
  baseline: evaluate(baseline),
  candidate: evaluate(candidate),
  limitations: [
    "Controlled Gaussian blur is not ground truth for naturally misfocused photographs.",
    "Reference originals were not independently labelled as perfectly sharp.",
    "Holdouts excluded from fitting; inconclusive counts are not silently excluded.",
    "Only six source photographs; no representative camera/noise/lighting accuracy claim.",
    "Candidate profile is NOT enabled in the application.",
  ],
};
await writeFile(
  join(root, "validation-report.json"),
  JSON.stringify(report, null, 2),
);
await writeFile(
  join(root, "candidate-profile.json"),
  JSON.stringify(candidate, null, 2),
);
console.log(
  JSON.stringify(
    {
      thresholds,
      candidate: candidate,
      baseline: report.baseline.groups,
      ratio: report.candidate.groups,
    },
    null,
    2,
  ),
);
