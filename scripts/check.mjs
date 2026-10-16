import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const appDirectory = "sites/filecopier-web/dist";
const testsDirectory = "sites/filecopier-web/tests";

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const directory of [appDirectory, testsDirectory, "scripts"]) {
  for (const file of await readdir(path.join(root, directory))) {
    if (file.endsWith(".mjs")) run(["--check", path.join(directory, file)]);
  }
}

const index = path.join(root, appDirectory, "index.html");
const html = await readFile(index, "utf8");
// The fake DOM in interaction tests must not hide missing IDs in the real HTML.
const htmlIds = new Set(
  [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]),
);
const application = await readFile(
  path.join(root, appDirectory, "app.mjs"),
  "utf8",
);
for (const match of application.matchAll(/\$\("([^"]+)"\)/g)) {
  if (!htmlIds.has(match[1]))
    throw new Error(`Application element missing from HTML: ${match[1]}`);
}
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const reference = match[1];
  if (/^(?:https?:|mailto:|#)/.test(reference)) continue;
  const target = fileURLToPath(new URL(reference, pathToFileURL(index)));
  if (!target.startsWith(path.join(root, appDirectory) + path.sep)) {
    throw new Error(`HTML reference leaves the public directory: ${reference}`);
  }
  await stat(target);
}
console.log("PASS: JavaScript syntax and local HTML references.");
run(["scripts/sync-pages.mjs", "--check"]);
const tests = (await readdir(path.join(root, testsDirectory)))
  .filter((file) => file.endsWith(".test.mjs"))
  .map((file) => path.join(testsDirectory, file));
run(["--test", ...tests]);
