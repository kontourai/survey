/**
 * Queue-binding attestation: a decision is only projectable against the exact
 * queue bytes it was recorded against.
 *
 * The binding is a small, serializable record created ONCE, when a review
 * round/session opens, and carried unchanged by every later write. Validation
 * compares a presented queue against that stored record. The division of labor
 * is deliberate and is the entire security property:
 *
 * - **The consumer persists the binding beside the queue and never recomputes
 *   it.** A digest a writer recomputes as it saves attests nothing — both sides
 *   of the comparison then regenerate from the same mutable bytes and agree by
 *   construction. That tautology shipped in a real consumer and let a
 *   post-decision edit export a substituted value (kontourai/fieldwork#60).
 * - **Survey owns the rule and the refusal.** What a queue edit looks like, in
 *   both directions, and when a comparison is vacuous, is decided here so no
 *   consumer rediscovers it four adversarial review rounds at a time
 *   (kontourai/survey#213).
 *
 * The binding alone cannot survive a writer who edits the queue AND re-binds —
 * hashing mutated bytes yields a self-consistent pair. For queues imported from
 * an extraction envelope, {@link validateReviewQueueAgainstExtractionImport}
 * narrows that hole to the record: it re-derives the canonical items from the
 * presented import record and refuses a queue that diverges from it in either
 * direction, so a queue edited independently of its record fails. What it
 * attests is queue-to-record CONSISTENCY, not record integrity. The portable
 * envelope carries the prepared artifact's digest and contentLength, never the
 * prepared bytes, so a library handed only the record cannot verify proposal
 * bytes against the digested artifact — a writer who edits the RECORD's
 * proposals and re-derives the queue from the edited record presents a
 * self-consistent pair this module blesses (pinned as a boundary test and by
 * check:guards). Keeping the stored record equal to the record originally
 * imported is the caller's storage obligation, and validating prepared bytes
 * against `result.preparedArtifact.digest` does NOT discharge it: that digest
 * covers the prepared artifact only, so it protects artifact integrity and
 * stays green through a proposal rewrite. Preserving record integrity takes
 * one of: a record digest/MAC anchored where the record's writer cannot
 * reach, immutable or authenticated record storage, or independently
 * re-deriving the proposals from trusted prepared bytes and comparing.
 *
 * Four bypasses from fieldwork#60's rounds, each a design input here:
 * 1. Self-agreement (above) — the binding's origin is the open, not the save.
 * 2. One-way set checks — validation walks BOTH directions, because checking
 *    only the items present can never notice one was removed.
 * 3. Trusting a mutable label over the identity it claims — out of scope here
 *    by construction: nothing in this module dispatches on a label; recheck
 *    semantics stay with the consumer that owns them.
 * 4. Vacuous success — an empty queue cannot be bound and never validates,
 *    because a receipt over nothing certifies nothing.
 */
import { canonicalJson } from "./canonical.js";
import { sha256Hex } from "../sha256.js";
import type { ReviewQueueSessionState } from "./review-queue-session.js";
import { reviewResourceApiVersion, type ReviewItem } from "../review-resource.js";
import {
  buildReviewItemsFromExtractionEnvelopeImport,
  validateExtractionEnvelopeImport,
  type ExtractionEnvelopeImportResult,
} from "../extraction-envelope.js";

/**
 * The durable attestation record. Serializable; a consumer stores it beside the
 * queue when the round opens and presents it, unchanged, at every later
 * validation.
 *
 * `itemNames` is deliberately redundant with the hash: it is what makes a
 * refusal diagnosable (which item was removed or added, by name) and it keeps
 * the set comparison independent of the hash derivation.
 */
export interface ReviewQueueBinding {
  readonly apiVersion: typeof reviewResourceApiVersion;
  readonly kind: "ReviewQueueBinding";
  readonly spec: {
    readonly sessionName: string;
    /** sha256 of the canonical open-time snapshot; see {@link hashReviewQueueSnapshot}. */
    readonly snapshotHash: string;
    /** Sorted, unique names of every ReviewItem the binding covers. Never empty. */
    readonly itemNames: readonly string[];
    /** ISO timestamp of when the binding was taken. Informational, not trusted. */
    readonly boundAt: string;
  };
}

export type ReviewQueueBindingIssueCode =
  | "binding-malformed"
  | "session-name-mismatch"
  | "empty-queue"
  | "ambiguous-item-identity"
  | "snapshot-hash-mismatch"
  | "item-removed"
  | "item-added";

export interface ReviewQueueBindingIssue {
  readonly code: ReviewQueueBindingIssueCode;
  readonly message: string;
  /** The ReviewItem name a set-membership issue is about, when there is one. */
  readonly itemName?: string;
}

export class UnattestedReviewQueueError extends Error {
  readonly name = "UnattestedReviewQueueError";
  readonly issues: readonly ReviewQueueBindingIssue[];

  constructor(issues: readonly ReviewQueueBindingIssue[]) {
    super(`Review queue is not attested by its binding: ${issues.map((issue) => issue.message).join(" ")}`);
    this.issues = issues;
  }
}

export interface BindReviewQueueOptions {
  readonly sessionName: string;
  /** Defaults to now. Informational only; nothing validates against it. */
  readonly boundAt?: Date | string;
}

export interface ValidateReviewQueueBindingOptions {
  /** When set, the binding must name this session. */
  readonly sessionName?: string;
}

/**
 * The digest a binding stores: sha256 over the canonical JSON of the whole
 * open-time session state. Byte-identical to server-review-session's
 * `hashReviewSessionSnapshot` (pinned by test), so a consumer already
 * persisting that digest adopts the binding without invalidating stored state.
 */
export function hashReviewQueueSnapshot(snapshot: ReviewQueueSessionState): string {
  return sha256Hex(canonicalJson(snapshot));
}

/**
 * Take the binding for a queue, once, when the round/session opens.
 *
 * Call this at queue construction and persist the result beside the queue.
 * Calling it again later, on bytes that may have changed, produces a binding
 * that agrees with whatever it was given — which is the self-agreement bypass,
 * not an attestation.
 *
 * Refuses an empty queue: a binding over nothing validates nothing, and every
 * later check against it would be vacuously green. Refuses duplicate item
 * names: the binding's set comparison is by name, so an ambiguous name would
 * let two different items answer for one membership.
 */
export function bindReviewQueue(
  snapshot: ReviewQueueSessionState,
  options: BindReviewQueueOptions,
): ReviewQueueBinding {
  if (!options.sessionName) {
    throw new Error("bindReviewQueue requires a non-empty sessionName.");
  }
  if (snapshot.items.length === 0) {
    throw new Error("bindReviewQueue refuses an empty queue: a binding over nothing attests nothing.");
  }
  const names = snapshot.items.map((item) => item.metadata.name);
  const unique = new Set(names);
  if (unique.size !== names.length) {
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    throw new Error(`bindReviewQueue refuses a queue with duplicate ReviewItem name ${duplicate}: set membership by name must be unambiguous.`);
  }

  return {
    apiVersion: reviewResourceApiVersion,
    kind: "ReviewQueueBinding",
    spec: {
      sessionName: options.sessionName,
      snapshotHash: hashReviewQueueSnapshot(snapshot),
      itemNames: [...unique].sort(),
      boundAt: options.boundAt instanceof Date ? options.boundAt.toISOString() : options.boundAt ?? new Date().toISOString(),
    },
  };
}

/**
 * Compare a presented queue against its stored binding.
 *
 * `binding` must be the record persisted when the round opened — passing one
 * derived from `snapshot` here checks nothing (see module doc). `snapshot` is
 * the base queue the binding was taken over, not the state after event replay:
 * decisions live in the event log precisely so the bound bytes never move.
 *
 * A malformed binding fails closed with `binding-malformed` rather than
 * skipping the checks it cannot perform.
 */
export function validateReviewQueueBinding(
  binding: ReviewQueueBinding,
  snapshot: ReviewQueueSessionState,
  options: ValidateReviewQueueBindingOptions = {},
): ReviewQueueBindingIssue[] {
  const structural = structuralBindingIssues(binding);
  if (structural.length > 0) {
    return structural;
  }

  const issues: ReviewQueueBindingIssue[] = [];
  if (options.sessionName !== undefined && binding.spec.sessionName !== options.sessionName) {
    issues.push({
      code: "session-name-mismatch",
      message: `Binding names session ${binding.spec.sessionName}, but this queue belongs to session ${options.sessionName}.`,
    });
  }
  if (snapshot.items.length === 0) {
    issues.push({
      code: "empty-queue",
      message: "The presented queue is empty. The binding covers items this queue no longer carries, and an empty queue attests nothing.",
    });
  }
  const presentNames = snapshot.items.map((item) => item.metadata.name);
  const present = new Set(presentNames);
  if (present.size !== presentNames.length) {
    const duplicate = presentNames.find((name, index) => presentNames.indexOf(name) !== index);
    issues.push({
      code: "ambiguous-item-identity",
      message: `The presented queue carries duplicate ReviewItem name ${duplicate}; set membership by name is ambiguous.`,
      itemName: duplicate,
    });
  }

  // Set equality in BOTH directions. Walking only the items present can never
  // notice an item was removed; walking only the bound names can never notice
  // one was added. Each direction is a different edit.
  const bound = new Set(binding.spec.itemNames);
  for (const name of binding.spec.itemNames) {
    if (!present.has(name)) {
      issues.push({
        code: "item-removed",
        message: `ReviewItem ${name} is covered by the binding but missing from the presented queue.`,
        itemName: name,
      });
    }
  }
  for (const name of present) {
    if (!bound.has(name)) {
      issues.push({
        code: "item-added",
        message: `ReviewItem ${name} is in the presented queue but not covered by the binding.`,
        itemName: name,
      });
    }
  }

  const actualHash = hashReviewQueueSnapshot(snapshot);
  if (binding.spec.snapshotHash !== actualHash) {
    issues.push({
      code: "snapshot-hash-mismatch",
      message: `The presented queue's bytes do not match the binding (expected ${binding.spec.snapshotHash}, got ${actualHash}). The queue changed after the round opened.`,
    });
  }

  return issues;
}

export function assertReviewQueueBinding(
  binding: ReviewQueueBinding,
  snapshot: ReviewQueueSessionState,
  options: ValidateReviewQueueBindingOptions = {},
): void {
  const issues = validateReviewQueueBinding(binding, snapshot, options);
  if (issues.length > 0) {
    throw new UnattestedReviewQueueError(issues);
  }
}

export type ReviewQueueExtractionIssueCode =
  | "import-not-grounded"
  | "empty-queue"
  | "item-missing-from-queue"
  | "item-not-in-extraction"
  | "item-diverges-from-extraction";

export interface ReviewQueueExtractionIssue {
  readonly code: ReviewQueueExtractionIssueCode;
  readonly message: string;
  readonly itemName?: string;
}

export class UnattestedExtractionQueueError extends Error {
  readonly name = "UnattestedExtractionQueueError";
  readonly issues: readonly ReviewQueueExtractionIssue[];

  constructor(issues: readonly ReviewQueueExtractionIssue[]) {
    super(`Review queue is not attested by its extraction import: ${issues.map((issue) => issue.message).join(" ")}`);
    this.issues = issues;
  }
}

/**
 * Check a stored queue for consistency with the extraction import record it
 * was derived from.
 *
 * The queue binding alone cannot catch a writer who edits the queue and
 * re-binds: hashing mutated bytes yields a self-consistent pair. This check
 * closes the QUEUE half of that hole: it revalidates the presented record
 * through the public import boundary (a forged `grounded` status throws; an
 * ungrounded import is refused), re-derives the canonical ReviewItems from it,
 * and requires the stored queue to be the SAME SET, byte-identically per item,
 * in both directions. A queue edited independently of its record fails.
 *
 * What it does NOT attest: the record itself. The envelope carries the
 * prepared artifact's digest and contentLength, never the prepared bytes, so
 * a library handed only the record cannot verify a proposal's bytes against
 * the digested artifact. A writer who edits the record's proposals and
 * re-derives the queue from the edited record presents a pair this check
 * blesses, while `result.preparedArtifact.digest` still names the honest
 * bytes. Record integrity is therefore the caller's storage obligation, and
 * checking prepared bytes against that digest does not meet it — the digest
 * covers the artifact, not the proposals, so it stays green through the
 * rewrite. Meeting it takes one of: a record digest/MAC anchored where the
 * record's writer cannot reach, immutable or authenticated record storage,
 * or independently re-deriving the proposals from trusted prepared bytes and
 * comparing. This limit is pinned by a boundary test and by
 * scripts/check-guards.mjs.
 *
 * This is the whole-extraction rule: it applies to a queue whose items all come
 * from one import. A consumer whose rounds mix in items the extraction cannot
 * attest (recheck rounds against a prior observation, for one) owns that
 * dispatch and those semantics — deciding which attestation applies to which
 * item from a mutable label is bypass 3, and it stays with the data that can
 * cross-check the label.
 */
export function validateReviewQueueAgainstExtractionImport(
  items: readonly ReviewItem[],
  importResult: ExtractionEnvelopeImportResult,
): ReviewQueueExtractionIssue[] {
  const record = validateExtractionEnvelopeImport(importResult.record);
  if (record.status.state !== "grounded") {
    return [{
      code: "import-not-grounded",
      message: `Extraction import ${record.metadata.name} is ${record.status.state}, not grounded; it cannot attest a review queue.`,
    }];
  }
  if (items.length === 0) {
    return [{
      code: "empty-queue",
      message: "The stored queue is empty; there is nothing it can certify against this extraction.",
    }];
  }

  // Re-derived through the public import boundary, not read from the caller's
  // importResult.reviewItems: the record is validated above, and the canonical
  // items are a pure function of it, so the comparison is against what the
  // presented record actually says — not against a reviewItems array the
  // caller could have edited separately from it. The record itself is
  // caller-supplied and is NOT attested here; see the function doc.
  const attesting = new Map(
    buildReviewItemsFromExtractionEnvelopeImport(record).map((item) => [item.metadata.name, item]),
  );
  const stored = new Map(items.map((item) => [item.metadata.name, item]));

  const issues: ReviewQueueExtractionIssue[] = [];
  for (const [name, item] of attesting) {
    const found = stored.get(name);
    if (!found) {
      issues.push({
        code: "item-missing-from-queue",
        message: `ReviewItem ${name} is in the extraction but missing from the stored queue.`,
        itemName: name,
      });
      continue;
    }
    if (canonicalJson(found) !== canonicalJson(item)) {
      issues.push({
        code: "item-diverges-from-extraction",
        message: `ReviewItem ${name} does not match the extraction it was imported from.`,
        itemName: name,
      });
    }
  }
  for (const name of stored.keys()) {
    if (!attesting.has(name)) {
      issues.push({
        code: "item-not-in-extraction",
        message: `ReviewItem ${name} is in the stored queue but not in the extraction.`,
        itemName: name,
      });
    }
  }

  return issues;
}

export function assertReviewQueueAgainstExtractionImport(
  items: readonly ReviewItem[],
  importResult: ExtractionEnvelopeImportResult,
): void {
  const issues = validateReviewQueueAgainstExtractionImport(items, importResult);
  if (issues.length > 0) {
    throw new UnattestedExtractionQueueError(issues);
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function structuralBindingIssues(binding: ReviewQueueBinding): ReviewQueueBindingIssue[] {
  const malformed = (message: string): ReviewQueueBindingIssue[] => [{
    code: "binding-malformed",
    message: `Malformed ReviewQueueBinding: ${message}`,
  }];

  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
    return malformed("not an object.");
  }
  if (binding.apiVersion !== reviewResourceApiVersion || binding.kind !== "ReviewQueueBinding") {
    return malformed(`unexpected identity ${String(binding.apiVersion)}/${String(binding.kind)}.`);
  }
  const spec = binding.spec;
  if (typeof spec !== "object" || spec === null) {
    return malformed("missing spec.");
  }
  if (typeof spec.sessionName !== "string" || spec.sessionName.length === 0) {
    return malformed("sessionName must be a non-empty string.");
  }
  if (typeof spec.snapshotHash !== "string" || !SHA256_HEX.test(spec.snapshotHash)) {
    return malformed("snapshotHash must be a 64-character lowercase hex sha256.");
  }
  if (typeof spec.boundAt !== "string" || spec.boundAt.length === 0) {
    return malformed("boundAt must be a non-empty ISO timestamp string.");
  }
  if (!Array.isArray(spec.itemNames) || spec.itemNames.length === 0) {
    return malformed("itemNames must be a non-empty array: a binding over nothing attests nothing.");
  }
  for (const name of spec.itemNames) {
    if (typeof name !== "string" || name.length === 0) {
      return malformed("itemNames must contain only non-empty strings.");
    }
  }
  const sorted = [...spec.itemNames].sort();
  if (new Set(spec.itemNames).size !== spec.itemNames.length
    || spec.itemNames.some((name, index) => name !== sorted[index])) {
    return malformed("itemNames must be unique and sorted.");
  }

  return [];
}
