#!/usr/bin/env node
// freeze-adrs.mjs — ADR freeze-and-index tooling.
//
// Freezes numbered ADRs under docs/adr/ as immutable history and seeds the
// topic-keyed decision registry (docs/decisions/) with `needs-decision` stubs
// that carry the frozen ADR(s) as provenance evidence.
//
// This is a PORTABLE, zero-runtime-dependency standalone script (node >=22,
// ESM). Piloted in kontourai/traverse (PR #17) per
// https://github.com/kontourai/flow-agents/issues/314; this copy rolls the
// same pattern out to survey's ADRs. Promotion into a reusable Builder Kit
// skill is deferred to a follow-up issue — this copy is intentionally
// survey-scoped (see SUBJECT_GROUPS below) rather than fully generic.
//
// Behavior (idempotent, content-preserving):
//   1. For each docs/adr/NNNN-*.md: prepend a frozen banner as the ONLY body
//      change. Skipped if the banner is already present.
//   2. Generate docs/adr/index.md: number, title, date (if derivable), link.
//      Deterministic — a second run with no ADR change is diff-clean.
//   3. For each SUBJECT_GROUPS entry, create/update a `status: needs-decision`
//      topic stub in docs/decisions/<slug>.md whose evidence[] links the
//      frozen ADR(s) (and any extra provenance) for that subject. Existing
//      stub frontmatter (status/decided) is preserved across reruns; only
//      missing evidence entries are appended, so the `decided` date recorded
//      at stub creation never drifts on a later rerun.
//
// Usage:
//   node scripts/freeze-adrs.mjs
//
// This script does NOT regenerate docs/decisions/index.md — that is owned by
// the vendored validator/generator, `node scripts/check-decisions.cjs
// gen-index` (npm run gen:decisions-index), per
// docs/decisions/decision-record.schema.json's source contract
// (context/contracts/decision-registry-contract.md in kontourai/flow-agents).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ADR_DIR = path.join(ROOT, "docs", "adr");
const ADR_INDEX_PATH = path.join(ADR_DIR, "index.md");
const DECISIONS_DIR = path.join(ROOT, "docs", "decisions");

const FROZEN_BANNER_MARKER = "FROZEN — immutable history.";
const FROZEN_BANNER =
  "> **FROZEN — immutable history.** Superseding/current decisions live in " +
  "[`docs/decisions/`](../decisions/index.md). Do not edit.\n\n";

// --- Subject grouping (survey-specific, reviewed by hand) -------------------
//
// Each ADR's decision subject is a NOUN drawn from (or added to) CONTEXT.md's
// domain vocabulary (Language section), per
// context/contracts/decision-registry-contract.md's slug rule.
//
// Groupings chosen for survey's 2 ADRs — both match existing CONTEXT.md terms
// verbatim, so no CONTEXT.md edit was needed for either:
//   - 0001 (untitled/unnumbered in-body, filename `0001-reviewed-current-
//     proposed-resolution.md`) -> "Reviewed Current/Proposed Resolution",
//     matching the CONTEXT.md term of the same name exactly (the term's
//     definition is this ADR's decision, restated as glossary language).
//   - 0003 (Inquiry Mapping and Producer Proposals) -> "Producer Profile",
//     matching the CONTEXT.md term that already cites "(ADR 0003)" inline as
//     the pluggable-producer-module rule this ADR establishes.
const SUBJECT_GROUPS = [
  {
    slug: "reviewed-current-proposed-resolution",
    subject: "Reviewed Current/Proposed Resolution",
    adrNumbers: [1],
  },
  {
    slug: "producer-profile",
    subject: "Producer Profile",
    adrNumbers: [3],
  },
];

function listAdrFiles() {
  if (!fs.existsSync(ADR_DIR)) return [];
  return fs
    .readdirSync(ADR_DIR)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .sort();
}

function adrNumberFromFilename(name) {
  return parseInt(name.slice(0, 4), 10);
}

function freezeOne(file) {
  const full = path.join(ADR_DIR, file);
  const raw = fs.readFileSync(full, "utf8");
  if (raw.includes(FROZEN_BANNER_MARKER)) {
    return { file, changed: false, raw };
  }
  const frozen = FROZEN_BANNER + raw;
  fs.writeFileSync(full, frozen, "utf8");
  return { file, changed: true, raw: frozen };
}

// Best-effort title/date extraction, tolerant of the banner already present.
// Survey's two ADRs have no formal "Date:"/"(YYYY-MM-DD)" field (0001 has
// none at all; 0003's only date is prose inside a reconstruction note, not a
// decision date), so both fall back to "unknown" in the generated index —
// that is a correct, honest reflection of the source material, not a script
// bug. This only affects generated index display, never the frozen ADR
// content.
function parseAdrMeta(file, raw) {
  const number = adrNumberFromFilename(file);
  const lines = raw.split(/\r?\n/);
  let title = file;
  for (const line of lines) {
    const m = line.match(/^#\s+(.*)$/);
    if (m) {
      title = m[1].trim().replace(/^ADR\s+\d+\s*[:—-]\s*/, "");
      break;
    }
  }
  const dateLineMatch = raw.match(/^\*{0,2}Date:\*{0,2}\s*(\d{4}-\d{2}-\d{2})/m);
  const parenMatch = raw.match(/\((\d{4}-\d{2}-\d{2})\)/);
  const date = dateLineMatch ? dateLineMatch[1] : parenMatch ? parenMatch[1] : null;
  return { number, file, title, date };
}

function renderAdrIndex(entries) {
  const sorted = [...entries].sort((a, b) => a.number - b.number);
  const lines = [];
  lines.push("---");
  lines.push("title: ADR Index");
  lines.push("---");
  lines.push("");
  lines.push("# ADR Index");
  lines.push("");
  lines.push("Generated by `node scripts/freeze-adrs.mjs`. Do not edit by hand.");
  lines.push(
    "Numbered ADRs below are FROZEN immutable history (see the banner on each " +
      "file). Current and superseding decisions live in " +
      "[docs/decisions/](../decisions/index.md); a frozen ADR's subject may be " +
      "carried forward there as a `needs-decision` stub or a ratified decision."
  );
  lines.push("");
  lines.push("| Number | Title | Date | Link |");
  lines.push("| --- | --- | --- | --- |");
  for (const e of sorted) {
    const num = String(e.number).padStart(4, "0");
    const date = e.date || "unknown";
    lines.push(`| ${num} | ${e.title} | ${date} | [${e.file}](./${e.file}) |`);
  }
  lines.push("");
  return lines.join("\n");
}

// --- Minimal frontmatter read for an existing stub, so a rerun preserves
// status/decided rather than re-deriving them (keeps `decided` stable across
// days and makes idempotency a real diff-clean, not just a lucky same-day
// rerun). Deliberately narrow: only reads the flat scalars + evidence[] shape
// this script itself writes.
function readExistingStub(slug) {
  const full = path.join(DECISIONS_DIR, `${slug}.md`);
  if (!fs.existsSync(full)) return null;
  const raw = fs.readFileSync(full, "utf8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const [, fmBlock, body] = fmMatch;
  const statusMatch = fmBlock.match(/^status:\s*(.+)$/m);
  const decidedMatch = fmBlock.match(/^decided:\s*(.+)$/m);
  const evidence = [];
  const evidenceBlockMatch = fmBlock.match(/^evidence:\n([\s\S]*?)(?:\n[a-z_]+:|$)/m);
  if (evidenceBlockMatch) {
    const itemRe = /-\s*kind:\s*(\S+)\n\s*ref:\s*(.+)/g;
    let m;
    while ((m = itemRe.exec(evidenceBlockMatch[1])) !== null) {
      evidence.push({ kind: m[1].trim(), ref: m[2].trim() });
    }
  }
  return {
    status: statusMatch ? statusMatch[1].trim() : null,
    decided: decidedMatch ? decidedMatch[1].trim() : null,
    evidence,
    body,
  };
}

function evidenceKey(e) {
  return `${e.kind}::${e.ref}`;
}

function renderStub({ subject, decided, evidence, body }) {
  const lines = [];
  lines.push("---");
  lines.push("status: needs-decision");
  lines.push(`subject: ${subject}`);
  lines.push(`decided: ${decided}`);
  lines.push("evidence:");
  for (const e of evidence) {
    lines.push(`  - kind: ${e.kind}`);
    lines.push(`    ref: ${e.ref}`);
  }
  lines.push("---");
  lines.push(body);
  return lines.join("\n");
}

function defaultStubBody(subject, adrFiles) {
  const adrLinks = adrFiles
    .map((f) => `[${f}](../adr/${f})`)
    .join(", ");
  const midSentence = subject.toLowerCase();
  return `
# ${subject}

This subject has provenance in frozen ADR history (${adrLinks}) but no living
decision has been ratified yet under the topic-keyed decision registry
(\`context/contracts/decision-registry-contract.md\` in kontourai/flow-agents).
This stub records that the subject is open and links the frozen ADR(s) as
provenance; it is not a decision.

When a living decision is ratified for ${midSentence},
update this file's \`status\` to \`current\`, add rationale, and keep the
\`adr\` evidence links as provenance for the history that led here.
`.trimStart();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function upsertStub(group, adrFilesByNumber) {
  const adrFiles = group.adrNumbers.map((n) => adrFilesByNumber.get(n));
  const desiredEvidence = [
    ...adrFiles.map((f) => ({ kind: "adr", ref: `docs/adr/${f}` })),
    ...(group.extraEvidence || []),
  ];

  const existing = readExistingStub(group.slug);
  const decided = existing?.decided || todayIso();
  const body = existing?.body || defaultStubBody(group.subject, adrFiles);

  const mergedEvidence = [];
  const seen = new Set();
  const source = existing ? existing.evidence.concat(desiredEvidence) : desiredEvidence;
  for (const e of source) {
    const key = evidenceKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    mergedEvidence.push(e);
  }

  const content = renderStub({
    subject: group.subject,
    decided,
    evidence: mergedEvidence,
    body,
  });

  const full = path.join(DECISIONS_DIR, `${group.slug}.md`);
  const priorRaw = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  if (priorRaw === content) {
    return { slug: group.slug, changed: false };
  }
  fs.mkdirSync(DECISIONS_DIR, { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return { slug: group.slug, changed: true };
}

function main() {
  const adrFilenames = listAdrFiles();
  if (adrFilenames.length === 0) {
    console.log("No docs/adr/NNNN-*.md files found; nothing to freeze.");
    return 0;
  }

  const frozen = adrFilenames.map(freezeOne);
  const bannerChanged = frozen.filter((f) => f.changed);
  for (const f of bannerChanged) {
    console.log(`Froze ${path.relative(ROOT, path.join(ADR_DIR, f.file))} (banner prepended).`);
  }

  const meta = frozen.map((f) => parseAdrMeta(f.file, f.raw));
  const adrIndexContent = renderAdrIndex(meta);
  const priorIndex = fs.existsSync(ADR_INDEX_PATH) ? fs.readFileSync(ADR_INDEX_PATH, "utf8") : null;
  if (priorIndex !== adrIndexContent) {
    fs.writeFileSync(ADR_INDEX_PATH, adrIndexContent, "utf8");
    console.log(`Wrote ${path.relative(ROOT, ADR_INDEX_PATH)}.`);
  }

  const adrFilesByNumber = new Map(adrFilenames.map((f) => [adrNumberFromFilename(f), f]));
  const stubResults = SUBJECT_GROUPS.map((g) => upsertStub(g, adrFilesByNumber));
  for (const r of stubResults.filter((r) => r.changed)) {
    console.log(`Wrote docs/decisions/${r.slug}.md (needs-decision stub).`);
  }

  // Chain the vendored index generator so a single `npm run freeze:adrs`
  // leaves docs/decisions/index.md current too (AC1: one command produces a
  // complete index + schema-valid stubs).
  const checkDecisions = path.join(ROOT, "scripts", "check-decisions.cjs");
  if (fs.existsSync(checkDecisions)) {
    execFileSync(process.execPath, [checkDecisions, "gen-index"], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }

  const anyChange =
    bannerChanged.length > 0 ||
    priorIndex !== adrIndexContent ||
    stubResults.some((r) => r.changed);
  console.log(
    anyChange
      ? "freeze-adrs: changes written."
      : "freeze-adrs: no-op (already frozen and current)."
  );
  return 0;
}

process.exit(main());
