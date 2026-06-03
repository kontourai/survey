#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const hookPath = join(repoRoot, ".githooks", "pre-push");

if (!existsSync(hookPath)) {
  console.error("Missing .githooks/pre-push. Restore the repo hook before setup.");
  process.exit(1);
}

chmodSync(hookPath, 0o755);
git(["config", "--local", "core.hooksPath", ".githooks"]);

const configuredPath = git(["config", "--local", "--get", "core.hooksPath"]);

if (configuredPath !== ".githooks") {
  console.error(`Expected local core.hooksPath to be .githooks, got ${configuredPath}`);
  process.exit(1);
}

console.log("Survey repo hooks installed: core.hooksPath=.githooks");
