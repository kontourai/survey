const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const kitRoot = path.join(root, "node_modules", "@kontourai", "console-kit");
const source = path.join(kitRoot, "tokens");
const target = path.join(root, "examples", "review-workbench", "vendor", "console-kit", "tokens");
const checkOnly = process.argv.includes("--check");

if (!fs.existsSync(kitRoot)) {
  throw new Error("Missing @kontourai/console-kit. Run npm install from the survey package.");
}

if (checkOnly) {
  assertSynced(source, target);
  console.log("Survey review workbench Console Kit vendor assets are synced.");
} else {
  fs.rmSync(path.dirname(target), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  console.log("Synced Survey review workbench Console Kit vendor assets.");
}

function assertSynced(sourcePath, targetPath) {
  const sourceStat = fs.lstatSync(sourcePath);
  const targetStat = fs.lstatSync(targetPath);

  if (targetStat.isSymbolicLink()) {
    throw new Error(`Vendor asset must not be a symlink: ${targetPath}`);
  }

  if (sourceStat.isDirectory()) {
    if (!targetStat.isDirectory()) {
      throw new Error(`Expected directory: ${targetPath}`);
    }

    const sourceEntries = fs.readdirSync(sourcePath).sort();
    const targetEntries = fs.readdirSync(targetPath).sort();
    if (sourceEntries.join("\0") !== targetEntries.join("\0")) {
      throw new Error(`Vendor directory drifted: ${targetPath}`);
    }

    for (const entry of sourceEntries) {
      assertSynced(path.join(sourcePath, entry), path.join(targetPath, entry));
    }
    return;
  }

  if (!targetStat.isFile()) {
    throw new Error(`Expected file: ${targetPath}`);
  }

  const sourceContent = fs.readFileSync(sourcePath);
  const targetContent = fs.readFileSync(targetPath);
  if (!sourceContent.equals(targetContent)) {
    throw new Error(`Vendor file drifted: ${targetPath}`);
  }
}
