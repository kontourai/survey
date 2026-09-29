import { sha256Hex } from "../sha256.js";
import { canonicalJson } from "./canonical.js";
import type { ReviewItem } from "../review-resource.js";
import {
  assertAuditRate,
  assertAuditSeed,
  initialReviewQueueSessionState,
  type ReviewQueueSessionState,
} from "./review-queue-session.js";

export interface RandomAuditSampleOptions {
  /** Inclusion probability for each item, greater than 0 and at most 1. */
  readonly rate: number;
  /** Any non-empty string. The same seed and items always draw the same sample. */
  readonly seed: string;
}

/**
 * Draws a seeded random audit sample from `items`, for example the items an
 * auto-accept threshold would have accepted without review.
 *
 * Each item is included on its own when a SHA-256 of `(seed, item name)`,
 * read as a number in [0, 1), is below `rate`. The draw is deterministic, does
 * not depend on the order of `items`, and an item's inclusion does not change
 * when other items are added or removed. Items keep their input order. Item
 * names must be unique.
 */
export function drawRandomAuditSample(items: readonly ReviewItem[], options: RandomAuditSampleOptions): ReviewItem[] {
  assertAuditRate(options.rate);
  assertAuditSeed(options.seed);
  const names = new Set<string>();
  for (const item of items) {
    if (names.has(item.metadata.name)) {
      throw new Error(`Audit sample items must have unique names; ${item.metadata.name} appears twice.`);
    }
    names.add(item.metadata.name);
  }
  return items.filter((item) => auditDraw(options.seed, item.metadata.name) < options.rate);
}

/**
 * Draws a random audit sample (see {@link drawRandomAuditSample}) and opens it
 * as a score-blind review session: the session hides every confidence and
 * verifier result, and each decision made in it records
 * `presentation: { scoreBlind: true }` and
 * `sampling: { kind: "random-audit", rate, seed }`.
 *
 * Throws when the draw selects no item, since a session needs one.
 */
export function openRandomAuditSession(
  items: readonly ReviewItem[],
  options: RandomAuditSampleOptions & { readonly reviewedAt?: string; readonly actorId?: string },
): ReviewQueueSessionState {
  const sample = drawRandomAuditSample(items, options);
  if (sample.length === 0) {
    throw new Error(`The random audit sample at rate ${options.rate} drew no items from ${items.length}; use a higher rate or more items.`);
  }
  const base = initialReviewQueueSessionState(sample);
  return {
    ...base,
    ...(options.reviewedAt !== undefined ? { reviewedAt: options.reviewedAt } : {}),
    ...(options.actorId !== undefined ? { actorId: options.actorId } : {}),
    presentation: { scoreBlind: true },
    sampling: { kind: "random-audit", rate: options.rate, seed: options.seed },
  };
}

/** A deterministic number in [0, 1) from the first 52 bits of a SHA-256. */
function auditDraw(seed: string, itemName: string): number {
  const hex = sha256Hex(canonicalJson(["survey.random-audit.v1", seed, itemName])).slice(0, 13);
  return Number.parseInt(hex, 16) / 2 ** 52;
}
