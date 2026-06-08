const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const installedKitRoot = path.join(root, "node_modules", "@kontourai", "console-kit");
const target = path.join(root, "examples", "review-workbench", "vendor", "console-kit", "tokens");
const checkOnly = process.argv.includes("--check");

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const kitRoot = await resolveKitRoot();
  const source = path.join(kitRoot, "tokens");

  if (checkOnly) {
    await compareDirectories(source, target);
    console.log("Survey review workbench Console Kit assets are synced.");
    return;
  }

  await fs.rm(path.dirname(target), { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
  console.log("Synced Survey review workbench Console Kit assets.");
}

async function resolveKitRoot() {
  const stat = await fs.lstat(installedKitRoot).catch(() => undefined);
  if (!stat?.isDirectory() && !stat?.isSymbolicLink()) {
    throw new Error("Missing @kontourai/console-kit. Run npm install before syncing review workbench assets.");
  }
  await assertPackageName(installedKitRoot);
  return installedKitRoot;
}

async function assertPackageName(candidate) {
  const packageJson = JSON.parse(await fs.readFile(path.join(candidate, "package.json"), "utf8"));
  if (packageJson.name !== "@kontourai/console-kit") {
    throw new Error(`Expected @kontourai/console-kit at ${candidate}, found ${packageJson.name ?? "unnamed package"}.`);
  }
}

async function compareDirectories(sourceDir, targetDir) {
  const [sourceStat, targetStat] = await Promise.all([fs.lstat(sourceDir), fs.lstat(targetDir)]);
  if (targetStat.isSymbolicLink()) throw new Error(`Vendor asset must not be a symlink: ${targetDir}`);
  if (!sourceStat.isDirectory() || !targetStat.isDirectory()) throw new Error(`Expected directory: ${targetDir}`);

  const sourceEntries = await fs.readdir(sourceDir, { withFileTypes: true });
  const targetEntries = await fs.readdir(targetDir, { withFileTypes: true });
  const sourceNames = sourceEntries.map((entry) => entry.name).sort();
  const targetNames = targetEntries.map((entry) => entry.name).sort();
  const targetByName = new Map(targetEntries.map((entry) => [entry.name, entry]));

  if (sourceNames.join("\0") !== targetNames.join("\0")) {
    throw new Error(`Vendor directory drifted: ${targetDir}`);
  }

  for (const sourceEntry of sourceEntries) {
    const sourcePath = path.join(sourceDir, sourceEntry.name);
    const targetPath = path.join(targetDir, sourceEntry.name);
    const targetEntry = targetByName.get(sourceEntry.name);
    if (!targetEntry || targetEntry.isSymbolicLink()) {
      throw new Error(`Vendor asset must not be a symlink: ${targetPath}`);
    }
    if (sourceEntry.isDirectory()) {
      await compareDirectories(sourcePath, targetPath);
    } else if (sourceEntry.isFile()) {
      if (!targetEntry.isFile()) throw new Error(`Expected file: ${targetPath}`);
      await compareFiles(sourcePath, targetPath);
    }
  }
}

async function compareFiles(sourcePath, targetPath) {
  const [sourceContent, targetContent] = await Promise.all([fs.readFile(sourcePath), fs.readFile(targetPath)]);
  if (!sourceContent.equals(targetContent)) {
    throw new Error(`Vendor file drifted: ${targetPath}`);
  }
}
