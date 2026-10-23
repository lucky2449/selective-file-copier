import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  classifyFaceMotion,
  FACE_MOTION_VERSION,
} from "../sites/filecopier-web/dist/face-motion.mjs";
const root = resolve(
  process.argv[2] ?? ".local/portrait-development/face-motion-audit",
);
const manifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8"),
);
const data = JSON.parse(
  await readFile(
    join(
      root,
      process.argv.includes("--offline")
        ? "offline-measurements.json"
        : "measurements.json",
    ),
    "utf8",
  ),
);
const rows = manifest.map((m) => ({
  ...m,
  ...data.find((r) => r.name === m.name),
}));
if (rows.some((r) => !r.result || r.error))
  throw Error("Missing or failed measurements");
const train = rows.filter(
  (r) => r.split === "train" && r.label !== "ambiguous",
);
const trainGroups = new Set(train.map((r) => r.group));
if (rows.some((r) => r.split === "holdout" && trainGroups.has(r.group)))
  throw Error("Capture-session leakage");
function decision(row, profile) {
  const values = (row.result.faceMotion ?? []).map((face) =>
    classifyFaceMotion(face.evidence, profile),
  );
  return (
    values.find((v) => v.verdict === "motion_suspected") ??
    (values.length && values.every((v) => v.verdict === "no_signal")
      ? { verdict: "no_signal", reasons: [] }
      : { verdict: "inconclusive", reasons: [] })
  );
}
let best = null,
  checked = 0;
for (const maxLaplacian of [2, 3, 5, 8])
  for (const maxTenengrad of [8, 12, 20, 30])
    for (const minEdges of [3, 6, 10])
      for (const minRegions of [2, 3])
        for (const widths of [
          [3, 2],
          [4, 2],
          [4, 3],
          [5, 3],
          [6, 4],
        ])
          for (const ratio of [1.15, 1.35, 1.6, 2])
            for (const ghostRate of [0.1, 0.2, 0.35, 0.5])
              for (const minGhosts of [2, 4, 6]) {
                const profile = {
                  version: FACE_MOTION_VERSION,
                  minEdges,
                  minRegions,
                  widths,
                  ratio,
                  ghostRate,
                  minGhosts,
                  maxLaplacian,
                  maxTenengrad,
                };
                checked++;
                const outcomes = train.map((row) => ({
                  row,
                  decision: decision(row, profile),
                }));
                const fp = outcomes.filter(
                  (r) =>
                    r.row.label === "sharp_reviewed_candidate" &&
                    r.decision.verdict === "motion_suspected",
                ).length;
                const tp = outcomes.filter(
                  (r) =>
                    r.row.label === "blur" &&
                    r.decision.verdict === "motion_suspected",
                ).length;
                // Select using training sessions only; no holdout decisions enter this ranking.
                const strictness =
                  -maxLaplacian -
                  maxTenengrad / 5 +
                  minEdges +
                  minRegions * 5 +
                  widths[0] +
                  widths[1] +
                  ratio * 3 +
                  ghostRate * 10 +
                  minGhosts;
                if (
                  fp === 0 &&
                  (!best ||
                    tp > best.tp ||
                    (tp === best.tp && strictness > best.strictness))
                )
                  best = { profile, tp, fp, strictness };
              }
const profile = process.argv.includes("--frozen")
  ? JSON.parse(await readFile(join(root, "frozen-profile.json"), "utf8"))
  : best?.tp
    ? best.profile
    : null;
const detail = rows.map((row) => ({
  name: row.name,
  label: row.label,
  group: row.group,
  split: row.split,
  reviewNote: row.reviewNote,
  faces: row.result.faceMotion?.length ?? 0,
  decision: decision(row, profile),
}));
const groups = [];
for (const split of ["train", "holdout"])
  for (const label of ["blur", "sharp_reviewed_candidate", "ambiguous"]) {
    const selected = detail.filter(
      (r) => r.split === split && r.label === label,
    );
    groups.push({
      split,
      label,
      total: selected.length,
      suspected: selected.filter(
        (r) => r.decision.verdict === "motion_suspected",
      ).length,
      noSignal: selected.filter((r) => r.decision.verdict === "no_signal")
        .length,
      inconclusive: selected.filter(
        (r) => r.decision.verdict === "inconclusive",
      ).length,
    });
  }
const report = {
  version: FACE_MOTION_VERSION,
  checkedProfiles: checked,
  selectedFromTrainingOnly: true,
  profileSource: process.argv.includes("--frozen")
    ? "frozen offline training profile"
    : "training grid",
  profile,
  bestTraining: best,
  groups,
  detail,
  limitations: [
    "Sharp comparison labels are visual review candidates, not independent photographer labels.",
    "Ambiguous candidates retained in separate counts.",
    "No photograph or metric is uploaded.",
    "No deployment/production accuracy guarantee.",
  ],
};
await writeFile(
  join(
    root,
    process.argv.includes("--offline") ? "offline-report.json" : "report.json",
  ),
  JSON.stringify(report, null, 2),
);
if (profile)
  await writeFile(
    join(root, "candidate-profile.json"),
    JSON.stringify(profile, null, 2),
  );
console.log(JSON.stringify({ profile, groups, training: best }, null, 2));
