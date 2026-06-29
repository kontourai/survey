// Single canonical JSON serializer shared by the review-workbench structural
// comparison (`structuralEqual`) and the server-side snapshot hashing, so the
// same object always produces the same canonical string and hash.
//
// Previously two near-identical copies lived in review-workbench.ts and
// server-review-session.ts and disagreed on Date handling — the workbench copy
// turned a Date into `{}` (no own enumerable keys), while the server copy used
// the ISO string. That desynced `structuralEqual` from snapshot freshness/replay
// hashes for any object carrying a Date (audit 2026-06-28, ops#24).

/**
 * Normalize a value into a deterministic, order-independent form: object keys
 * sorted, `undefined`-valued keys dropped, Dates rendered as ISO strings.
 */
export function canonicalize(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, canonicalize(entryValue)]),
    );
  }

  return value;
}

/** Deterministic JSON string for hashing or structural comparison. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
