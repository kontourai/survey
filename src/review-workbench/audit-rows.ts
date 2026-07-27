/**
 * The AUDIT DETAILS row contract.
 *
 * Two separate concerns live here, and they are not the same thing:
 *
 * 1. **Naming.** Every row inside a field card's AUDIT DETAILS carries
 *    `data-audit-row="<key>"` — a stable machine name a host can select on.
 *    Row *labels* are display copy and change; these keys do not. A host that
 *    wants to restyle, reorder, or suppress a row on its own surface selects on
 *    the key. Deriving a selector from label text is not a supported way to
 *    address a row, and this attribute exists so nobody has to.
 *
 * 2. **Not printing the same fact twice.** Survey renders a card's identifiers
 *    and provenance in more than one place (the ID stack, the Raw Source
 *    section, each section's "IDs and trace links"). Where those placements
 *    carry the *same fact*, the card printed one value two or three times under
 *    different labels. {@link AuditFactTrace} keeps the first placement and
 *    drops the later ones. That is Survey's job, not a consumer's — see
 *    docs/consumer-integration-guide.md.
 */

/**
 * PUBLIC CONTRACT — every `data-audit-row` key Survey emits.
 *
 * Additive by policy: a key may be added, and a row may stop being emitted when
 * it is a duplicate placement or a constant, but a key is never renamed or
 * repointed at a different fact. Hosts may hold selectors against these values.
 */
export const reviewAuditRowKeys = [
  // Card-level identity
  "current-candidate-id",
  "proposed-candidate-id",
  "claim-id",
  "raw-source-id",
  "locator",
  "model",
  "extractor",
  "extracted-at",
  // Unselected candidate history
  "history-value",
  "candidate-id",
  // Raw Source
  "source-reference",
  "excerpt",
  "observed",
  "source-authority-class",
  "declared-by",
  "authority-scope",
  "extraction-id",
  // Review event
  "actor",
  "reviewed-at",
  "status",
  "rationale",
  "outcome",
  // Integrity posture
  "checksum",
  "candidate-set-id",
  // Authority trace
  "authority-trace-status",
  "authority-trace-detail",
] as const;

/** One of {@link reviewAuditRowKeys}. */
export type ReviewAuditRowKey = (typeof reviewAuditRowKeys)[number];

/**
 * The identity of a *fact*, not of a string: which record a value came from and
 * which property of it. Two placements share an identity only when they are the
 * same property of the same record — which is exactly when printing both says
 * nothing the first one did not.
 *
 * Matching on the rendered value instead conflates facts that merely coincide.
 * A candidate whose `extraction.extractedAt` equals its `source.observedAt` —
 * the stock fixture's shape, and a common one — would lose its `Observed` row
 * entirely, and an auditor reading the card could not tell that field had ever
 * existed. The labels differing is the signal that the facts differ.
 */
export interface AuditFactId {
  /** The record the value belongs to: a candidate id, or the review item. */
  readonly of: string;
  /** The property path within that record. */
  readonly property: string;
}

/**
 * Values that report a fact as missing rather than carrying one. Two placements
 * both reading "not provided" are not one fact printed twice, so a placeholder
 * never suppresses a later placement and is never suppressed by an earlier one.
 *
 * Deliberately only the literals the workbench itself substitutes for an absent
 * field, not a general vocabulary of nullish-looking words. Producer data is not
 * ours to interpret: an extractor genuinely named "none" would be misread as an
 * absence. "unknown" is the one string on both sides of that line — Survey emits
 * it for a missing extractor or timestamp, and a producer could conceivably use
 * it as a real name. The cost of getting that wrong is a duplicate row, never a
 * dropped one, so it stays.
 */
const ABSENCE_VALUES: ReadonlySet<string> = new Set([
  "not provided",
  "not recorded",
  "unknown",
]);

/** Per-card record of which facts have already been printed, and as what. */
export interface AuditFactTrace {
  /**
   * Records `fact` and reports whether this card has already printed it with
   * this same value. Placeholder and empty values are never recorded and never
   * suppressed.
   */
  isRepeatPlacement(fact: AuditFactId, value: unknown): boolean;
}

/**
 * Suppression requires BOTH conditions, and each rules out a different mistake.
 *
 * Identity alone would be too eager: placements that nominally report the same
 * property can resolve through different fallback chains (a projection override
 * versus the candidate's own field), so a matching identity does not guarantee
 * a matching value. Value alone would be far too eager — that is what conflates
 * `extracted-at` with `observed`.
 *
 * @param alreadyOnCard facts the card face shows outside AUDIT DETAILS (the
 *   quoted excerpt, for one), so the audit surface does not reprint them.
 */
export function createAuditFactTrace(
  alreadyOnCard: readonly (AuditFactId & { readonly value: unknown })[] = [],
): AuditFactTrace {
  const printed = new Map<string, string>();
  for (const fact of alreadyOnCard) {
    if (carriesAFact(fact.value)) {
      printed.set(factKey(fact), String(fact.value));
    }
  }

  return {
    isRepeatPlacement(fact: AuditFactId, value: unknown): boolean {
      if (!carriesAFact(value)) {
        return false;
      }
      const key = factKey(fact);
      const already = printed.get(key);
      if (already !== undefined) {
        // Same identity but a different value is a divergence worth showing,
        // not a repeat. Keep the first reading on record.
        return already === String(value);
      }
      printed.set(key, String(value));
      return false;
    },
  };
}

function factKey(fact: AuditFactId): string {
  return `${fact.of}::${fact.property}`;
}

function carriesAFact(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  const text = String(value).trim();
  return text.length > 0 && !ABSENCE_VALUES.has(text.toLocaleLowerCase());
}
