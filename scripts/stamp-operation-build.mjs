import { readFile, writeFile } from "node:fs/promises";
const sha = process.env.GITHUB_SHA;
if (!/^[0-9a-f]{40}$/.test(sha || ""))
  throw new Error("A valid GITHUB_SHA is required");
for (const base of ["sites/filecopier-web/dist", "docs"]) {
  const target = new URL(
    `../${base}/operation-log-config.mjs`,
    import.meta.url,
  );
  const text = await readFile(target, "utf8");
  if (!/buildId:\s*"(?:unversioned|[0-9a-f]{7,40})"/.test(text))
    throw new Error("Build configuration missing");
  await writeFile(
    target,
    text.replace(
      /buildId:\s*"(?:unversioned|[0-9a-f]{7,40})"/,
      `buildId: "${sha}"`,
    ),
  );
}
console.log("Stamped operation log build ID.");
