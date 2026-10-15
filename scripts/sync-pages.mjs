import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "sites/filecopier-web/dist");
const destination = path.join(root, "docs");
const checkOnly = process.argv.includes("--check");

async function filesIn(directory, prefix = "") {
  let entries;
  try {
    entries = await readdir(path.join(directory, prefix), {
      withFileTypes: true,
    });
  } catch (error) {
    if (error.code === "ENOENT" && directory === destination) return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Symlinks are not publishable: ${relative}`);
    if (entry.name.startsWith("."))
      throw new Error(`Hidden files are not publishable: ${relative}`);
    if (entry.isDirectory())
      files.push(...(await filesIn(directory, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

const sourceFiles = await filesIn(source);
if (!sourceFiles.includes("index.html"))
  throw new Error("Source index.html is missing.");
const destinationFiles = await filesIn(destination);
const stale = destinationFiles.filter((file) => !sourceFiles.includes(file));
const changed = [];
for (const file of sourceFiles) {
  const sourceBytes = await readFile(path.join(source, file));
  let destinationBytes;
  try {
    destinationBytes = await readFile(path.join(destination, file));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!destinationBytes || !sourceBytes.equals(destinationBytes))
    changed.push(file);
}

if (checkOnly) {
  if (changed.length || stale.length) {
    console.error("Pages output differs. Run npm run sync:pages.");
    for (const file of changed) console.error(`Update: docs/${file}`);
    for (const file of stale) console.error(`Remove: docs/${file}`);
    process.exitCode = 1;
  } else
    console.log(
      `PASS: Pages output matches ${sourceFiles.length} source files.`,
    );
} else {
  for (const file of changed) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(source, file), target);
  }
  // Remove files only inside the generated Pages directory, never source files.
  for (const file of stale) await rm(path.join(destination, file));
  console.log(
    `Pages synced: ${changed.length} updated, ${stale.length} removed.`,
  );
}
