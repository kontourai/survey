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
 *    section, each section's "IDs and trace links"). Where those coincide, the
 *    card printed one value three times under three labels. {@link AuditRowTrace}
 *    keeps the first printing and drops the repeats, per card. That is Survey's
 *    job, not a consumer's — see docs/consumer-integration-guide.md.
 */

/**
 * PUBLIC CONTRACT — every `data-audit-row` key Survey emits.
 *
 * Additive by policy: a key may be added, and a row may stop being emitted when
 * it is a duplicate or a constant, but a key is never renamed or repointed at a
 * different fact. Hosts may hold selectors against these values.
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
 * Values that say a fact is missing rather than carrying one. Two rows both
 * reading "not provided" are not the same fact printed twice, so the trace must
 * never collapse them.
 */
const ABSENCE_VALUES: ReadonlySet<string> = new Set([
  "not provided",
  "not recorded",
  "unknown",
  "none",
  "n/a",
]);

/**
 * Per-card record of which values have already been printed.
 *
 * Deduplication is by *value*, not by label, because the duplicates are the same
 * identifier under different labels ("Raw Source ID" / "Raw source ID"). It is
 * applied only to rows whose content is an identifier or a provenance scalar,
 * where an equal value means the same fact; prose rows (rationale, status,
 * history labels) are always printed.
 */
export interface AuditRowTrace {
  /**
   * Records `value` and reports whether this card has already printed it.
   * Absent/placeholder values are never recorded and never suppressed.
   */
  isRepeat(value: unknown): boolean;
}

/**
 * @param alreadyOnCard values the card face shows outside AUDIT DETAILS (the
 *   quoted excerpt, for one), so the audit surface does not reprint them.
 */
export function createAuditRowTrace(alreadyOnCard: readonly (string | undefined)[] = []): AuditRowTrace {
  const printed = new Set<string>();
  for (const value of alreadyOnCard) {
    const text = normalize(value);
    if (text) {
      printed.add(text);
    }
  }

  return {
    isRepeat(value: unknown): boolean {
      const text = normalize(value);
      if (!text) {
        return false;
      }
      if (printed.has(text)) {
        return true;
      }
      printed.add(text);
      return false;
    },
  };
}

function normalize(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  if (!text || ABSENCE_VALUES.has(text.toLocaleLowerCase())) {
    return undefined;
  }
  return text;
}
