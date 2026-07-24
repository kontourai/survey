const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");

const checker = resolve("scripts/check-content-boundary.cjs");
const prohibited = ["c", "a", "m", "p", "f", "i", "t"].join("");
const localGitEnvironmentVariables = execFileSync(
  "git",
  ["rev-parse", "--local-env-vars"],
  { encoding: "utf8" },
).trim().split(/\s+/).filter(Boolean);

function foreignGitEnvironment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  for (const name of localGitEnvironmentVariables) {
    delete environment[name];
  }
  return environment;
}

function git(directory, arguments_, baseEnvironment = process.env) {
  execFileSync("git", arguments_, {
    cwd: directory,
    env: foreignGitEnvironment(baseEnvironment),
  });
}

function fixtureRepository(baseEnvironment = process.env) {
  const directory = mkdtempSync(join(tmpdir(), "survey-content-boundary-"));
  mkdirSync(join(directory, "scripts"));
  copyFileSync(checker, join(directory, "scripts/check-content-boundary.cjs"));
  git(directory, ["init", "-q"], baseEnvironment);
  writeFileSync(join(directory, "tracked.txt"), "generic public fixture\n");
  git(directory, ["add", "tracked.txt"], baseEnvironment);
  return directory;
}

test("content boundary rejects an untracked non-ignored file", () => {
  const directory = fixtureRepository();
  try {
    writeFileSync(join(directory, "new-fixture.txt"), `${prohibited}\n`);
    const result = spawnSync(
      process.execPath,
      ["scripts/check-content-boundary.cjs"],
      {
        cwd: directory,
        encoding: "utf8",
        env: foreignGitEnvironment(),
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /new-fixture\.txt:1 private vertical product name/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("content boundary excludes ignored untracked files", () => {
  const directory = fixtureRepository();
  try {
    writeFileSync(join(directory, ".gitignore"), "ignored.txt\n");
    git(directory, ["add", ".gitignore"]);
    writeFileSync(join(directory, "ignored.txt"), `${prohibited}\n`);
    const result = spawnSync(
      process.execPath,
      ["scripts/check-content-boundary.cjs"],
      {
        cwd: directory,
        encoding: "utf8",
        env: foreignGitEnvironment(),
      },
    );

    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("foreign repository fixtures ignore a caller's Git-local environment", () => {
  const sentinelDirectory = mkdtempSync(join(tmpdir(), "survey-caller-git-"));
  const sentinelIndex = join(sentinelDirectory, "caller.index");
  const poisonedEnvironment = {
    ...process.env,
    GIT_DIR: resolve(".git"),
    GIT_INDEX_FILE: sentinelIndex,
  };
  const directory = fixtureRepository(poisonedEnvironment);

  try {
    assert.equal(existsSync(sentinelIndex), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(sentinelDirectory, { recursive: true, force: true });
  }
});
