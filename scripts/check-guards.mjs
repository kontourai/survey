/**
 * Fault injection for the queue-binding attestation guards (survey#213).
 *
 * A guard that no test fails without is decoration, and a passing suite cannot
 * tell you which of the two you have. This removes each guard in turn and
 * requires the suite that covers it to go red, so the claim "these checks are
 * load-bearing" is reproducible rather than reported. One entry is the
 * inverse: a PINNED BOUNDARY, which flips the coordinated-record-rewrite
 * test's pass-assertion and requires the suite to go red — pinning what the
 * module deliberately does NOT enforce, so the docs' scoping cannot silently
 * fall out of step with the code in either direction.
 *
 * Pattern carried from kontourai/fieldwork's scripts/check-guards.mjs (11/11
 * there): restores from git, verifies the restore byte-identically, and FAILS
 * rather than skips when a pattern stops matching — a missing pattern means a
 * guard moved or was removed, and the harness must not quietly bless that.
 * Compilation is judged separately from the suite: an injection that does not
 * compile is a matrix FAILURE (wrong attribution), never a catch, so "caught"
 * always means a test went red.
 *
 * Not part of `npm run verify`: it edits tracked source and restores it from
 * git, so it needs a clean tree and must not race a build. Run it directly:
 *
 *   npm run check:guards
 *
 * Survey's tests run from dist, so each injection recompiles (plain `tsc`, no
 * dist wipe) before running the suite, and the script ends with one clean
 * rebuild so dist never carries an injected guard.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const SUITE = "dist/tests/queue-binding.test.js";
const BINDING = "src/review-workbench/queue-binding.ts";
const SESSION = "src/review-workbench/server-review-session.ts";
const SUITE_SOURCE = "tests/queue-binding.test.ts";

const injections = [
  {
    label: "binding hash re-derived from the queue it checks (self-agreement)",
    file: BINDING,
    from: "  if (binding.spec.snapshotHash !== actualHash) {",
    to: "  if (hashReviewQueueSnapshot(snapshot) !== actualHash) {",
  },
  {
    label: "an item removed after open goes unnoticed (set equality, forward)",
    file: BINDING,
    from: "  for (const name of binding.spec.itemNames) {\n    if (!present.has(name)) {",
    to: "  for (const name of binding.spec.itemNames) {\n    if (false && !present.has(name)) {",
  },
  {
    label: "an item added after open goes unnoticed (set equality, reverse)",
    file: BINDING,
    from: "  for (const name of present) {\n    if (!bound.has(name)) {",
    to: "  for (const name of present) {\n    if (false && !bound.has(name)) {",
  },
  {
    label: "an emptied queue validates vacuously",
    file: BINDING,
    from: "  if (snapshot.items.length === 0) {\n    issues.push({\n      code: \"empty-queue\",",
    to: "  if (false) {\n    issues.push({\n      code: \"empty-queue\",",
  },
  {
    label: "an empty queue can be bound",
    file: BINDING,
    from: "  if (snapshot.items.length === 0) {\n    throw new Error(\"bindReviewQueue refuses an empty queue",
    to: "  if (false) {\n    throw new Error(\"bindReviewQueue refuses an empty queue",
  },
  {
    label: "a queue with duplicate item names can be bound",
    file: BINDING,
    from: "  if (unique.size !== names.length) {",
    to: "  if (false) {",
  },
  {
    label: "a malformed binding skips the checks instead of failing closed",
    file: BINDING,
    from: "  const structural = structuralBindingIssues(binding);\n  if (structural.length > 0) {\n    return structural;\n  }",
    to: "  const structural = [] as ReviewQueueBindingIssue[];\n  if (structural.length > 0) {\n    return structural;\n  }",
  },
  {
    label: "a binding for a different session is accepted",
    file: BINDING,
    from: "  if (options.sessionName !== undefined && binding.spec.sessionName !== options.sessionName) {",
    to: "  if (false) {",
  },
  {
    label: "extraction cross-check accepts diverged item bytes",
    file: BINDING,
    from: "    if (canonicalJson(found) !== canonicalJson(item)) {",
    to: "    if (false) {",
  },
  {
    label: "extraction cross-check misses a dropped item (forward)",
    file: BINDING,
    from: "    if (!found) {\n      issues.push({\n        code: \"item-missing-from-queue\",",
    to: "    if (false) {\n      issues.push({\n        code: \"item-missing-from-queue\",",
  },
  {
    label: "extraction cross-check misses a smuggled item (reverse)",
    file: BINDING,
    from: "    if (!attesting.has(name)) {",
    to: "    if (false) {",
  },
  {
    label: "extraction cross-check certifies an emptied queue",
    file: BINDING,
    from: "  if (items.length === 0) {\n    return [{\n      code: \"empty-queue\",",
    to: "  if (false) {\n    return [{\n      code: \"empty-queue\",",
  },
  {
    label: "extraction cross-check trusts the caller's record without revalidation",
    file: BINDING,
    from: "  const record = validateExtractionEnvelopeImport(importResult.record);",
    to: "  const record = importResult.record;",
  },
  {
    label: "an ungrounded import is allowed to attest a queue",
    file: BINDING,
    from: "  if (record.status.state !== \"grounded\") {",
    to: "  if (false) {",
  },
  {
    // The whole block is replaced, not just its first line: leaving the inner
    // currentSnapshot call unbanged fails tsc (options.binding no longer
    // narrows), and a guard "caught" by the compiler instead of the suite is
    // exactly the decorative attribution this matrix exists to rule out.
    label: "derive ignores the supplied binding",
    file: SESSION,
    from: "  if (options.binding) {\n    assertReviewQueueBinding(options.binding, options.record.snapshot, { sessionName: options.record.sessionName });\n    if (options.currentSnapshot) {\n      assertReviewQueueBinding(options.binding, options.currentSnapshot, { sessionName: options.record.sessionName });\n    }\n  }",
    to: "  if (false as boolean) {\n    assertReviewQueueBinding(options.binding!, options.record.snapshot, { sessionName: options.record.sessionName });\n    if (options.currentSnapshot) {\n      assertReviewQueueBinding(options.binding!, options.currentSnapshot, { sessionName: options.record.sessionName });\n    }\n  }",
  },
  {
    label: "derive checks the record's snapshot but not the caller's current one",
    file: SESSION,
    from: "    if (options.currentSnapshot) {\n      assertReviewQueueBinding(options.binding, options.currentSnapshot, { sessionName: options.record.sessionName });\n    }",
    to: "",
  },
  {
    // PINNED BOUNDARY, not a guard removal. The coordinated record rewrite —
    // edit the record's proposals, re-derive the queue from the edited record,
    // re-bind — is a documented PASS: the cross-check attests queue-to-record
    // consistency, and the envelope carries the prepared artifact's digest,
    // not its bytes, so record integrity is the caller's storage obligation.
    // This entry inverts the boundary test's pass-assertion and requires the
    // suite to go red, which proves the test observes a real pass rather than
    // being decoration; and if the boundary test is removed or reworded, the
    // pattern stops matching and the matrix FAILS rather than skips. Either
    // way, the documented limit cannot drift without failing here — if this
    // entry ever reports NOT CAUGHT, enforcement widened and the module doc,
    // the consumer guide, and the upgrade guide must be re-scoped in the same
    // change.
    label: "pinned boundary: a coordinated record rewrite must remain a documented pass",
    file: SUITE_SOURCE,
    from: "    assert.deepEqual(validateReviewQueueAgainstExtractionImport(items, { record: edited, reviewItems: items }), []);",
    to: "    assert.notDeepEqual(validateReviewQueueAgainstExtractionImport(items, { record: edited, reviewItems: items }), []);",
  },
];

const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
if (dirty) {
  throw new Error(`check:guards restores source from git, so it needs a clean tree. Uncommitted:\n${dirty}`);
}

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const results = [];

for (const injection of injections) {
  const before = digest(injection.file);
  const source = readFileSync(injection.file, "utf8");
  if (!source.includes(injection.from)) {
    results.push({ ...injection, outcome: "PATTERN MISSING" });
    continue;
  }
  writeFileSync(injection.file, source.replace(injection.from, injection.to));
  // Compile and test are judged SEPARATELY. A guard whose removal only breaks
  // the build is not covered by any test — counting a compile failure as
  // "caught" is the decorative-attribution lie this matrix exists to rule out
  // (it happened: the derive-ignores-binding injection was compiler-caught
  // until its repair). Only a red run of the targeted suite counts.
  let compiles = true;
  try {
    execFileSync("npx", ["tsc"], { stdio: "pipe" });
  } catch {
    compiles = false;
  }
  let caught = false;
  if (compiles) {
    try {
      execFileSync("node", ["--test", SUITE], { stdio: "pipe" });
    } catch {
      caught = true;
    }
  }
  execFileSync("git", ["checkout", "--", injection.file]);
  if (digest(injection.file) !== before) {
    throw new Error(`${injection.file} was not restored byte-identically after injection "${injection.label}"`);
  }
  results.push({
    ...injection,
    outcome: !compiles ? "DOES NOT COMPILE (wrong attribution)" : caught ? "caught" : "NOT CAUGHT",
  });
}

// Leave dist matching the restored source, never an injected guard.
execFileSync("npx", ["tsc"], { stdio: "pipe" });

for (const result of results) {
  console.log(`${result.outcome === "caught" ? "  caught" : `> ${result.outcome}`}  ${result.label}`);
}
const failures = results.filter((result) => result.outcome !== "caught");
console.log(`\n${results.length - failures.length}/${results.length} injections caught`);
if (failures.length > 0) {
  throw new Error(`${failures.length} injection(s) not caught by a red run of ${SUITE} (a non-compiling injection is wrong attribution, not a catch)`);
}
