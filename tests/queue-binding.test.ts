/**
 * Queue-binding attestation (kontourai/survey#213).
 *
 * The four bypasses from fieldwork#60's adversarial rounds each get a direct
 * test here, plus the end-to-end table that closed that issue:
 *
 *   honest control                          derives
 *   drop one item (+ rebuilt record)        REFUSED
 *   emptied queue                           REFUSED
 *   coordinated queue rewrite (+ re-bind)   REFUSED (by the extraction side)
 *   coordinated RECORD rewrite              PASSES — the pinned boundary: the
 *     (record edit + re-derive + re-bind)   cross-check attests queue-to-record
 *                                           consistency, not record integrity
 *
 * Every guard these tests cover is also fault-injected by
 * scripts/check-guards.mjs, which removes each guard in turn and requires this
 * suite to go red. The matrix also pins the boundary row above: it inverts the
 * boundary test's pass-assertion and requires this suite to go red, so the
 * documented limit stays load-bearing rather than prose.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertReviewQueueAgainstExtractionImport,
  assertReviewQueueBinding,
  bindReviewQueue,
  hashReviewQueueSnapshot,
  UnattestedReviewQueueError,
  validateReviewQueueAgainstExtractionImport,
  validateReviewQueueBinding,
  type ReviewQueueBinding,
} from "../src/index.js";
import {
  createServerReviewSessionRecord,
  deriveServerReviewSessionApplyResult,
  hashReviewSessionSnapshot,
} from "../src/review-workbench/server-review-session.js";
import { initialReviewQueueSessionState, type ReviewQueueSessionState } from "../src/review-workbench/review-queue-session.js";
import {
  buildReviewItemsFromExtractionEnvelopeImport,
  validateExtractionEnvelopeImport,
} from "../src/extraction-envelope.js";
import type { ReviewItem } from "../src/review-resource.js";
import { buildEnvelopeImportFixture, envelopeReviewQueueSession, ungroundedEnvelopeImportFixture as ungroundedImportFixture } from "./envelope-review-fixture.js";

const SESSION = "queue-binding-session";

function openQueue(): ReviewQueueSessionState {
  return envelopeReviewQueueSession();
}

function mutateFirstValue(snapshot: ReviewQueueSessionState): ReviewQueueSessionState {
  const items = structuredClone(snapshot.items) as ReviewItem[];
  (items[0]!.spec.candidates[0] as { value: unknown }).value = "substituted-after-review";
  return { ...snapshot, items };
}

function dropFirstItem(snapshot: ReviewQueueSessionState): ReviewQueueSessionState {
  const items = snapshot.items.slice(1);
  return { ...snapshot, items, activeItemName: items[0]!.metadata.name };
}

function codes(issues: readonly { code: string }[]): string[] {
  return [...new Set(issues.map((issue) => issue.code))].sort();
}

describe("bindReviewQueue", () => {
  it("binds the open queue: canonical hash, sorted unique names, serializable record", () => {
    const snapshot = openQueue();
    const binding = bindReviewQueue(snapshot, { sessionName: SESSION, boundAt: "2026-07-27T00:00:00.000Z" });

    assert.equal(binding.kind, "ReviewQueueBinding");
    assert.equal(binding.spec.sessionName, SESSION);
    assert.match(binding.spec.snapshotHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(binding.spec.itemNames, snapshot.items.map((item) => item.metadata.name).sort());
    assert.deepEqual(JSON.parse(JSON.stringify(binding)), binding);
  });

  it("produces the same digest as server-review-session's snapshot hash, byte for byte", () => {
    // A consumer already persisting hashReviewSessionSnapshot output (fieldwork
    // does) must be able to adopt the binding without invalidating stored
    // state. This pin is what makes that claim checkable.
    const snapshot = openQueue();
    assert.equal(hashReviewQueueSnapshot(snapshot), hashReviewSessionSnapshot(snapshot));
    assert.equal(bindReviewQueue(snapshot, { sessionName: SESSION }).spec.snapshotHash, hashReviewSessionSnapshot(snapshot));
  });

  it("refuses to bind an empty queue: a binding over nothing attests nothing", () => {
    const snapshot = { ...openQueue(), items: [], activeItemName: "" };
    assert.throws(() => bindReviewQueue(snapshot, { sessionName: SESSION }), /empty queue/);
  });

  it("refuses duplicate ReviewItem names: set membership by name must be unambiguous", () => {
    const snapshot = openQueue();
    const items = structuredClone(snapshot.items) as ReviewItem[];
    items[1]!.metadata.name = items[0]!.metadata.name;
    assert.throws(
      () => bindReviewQueue({ ...snapshot, items }, { sessionName: SESSION }),
      /duplicate ReviewItem name/,
    );
  });

  it("requires a session name", () => {
    assert.throws(() => bindReviewQueue(openQueue(), { sessionName: "" }), /sessionName/);
  });
});

describe("validateReviewQueueBinding", () => {
  it("accepts the exact queue the binding was taken over", () => {
    const snapshot = openQueue();
    const binding = bindReviewQueue(snapshot, { sessionName: SESSION });
    assert.deepEqual(validateReviewQueueBinding(binding, snapshot, { sessionName: SESSION }), []);
    assert.doesNotThrow(() => assertReviewQueueBinding(binding, snapshot, { sessionName: SESSION }));
  });

  it("refuses a queue whose bytes changed after the round opened", () => {
    const snapshot = openQueue();
    const binding = bindReviewQueue(snapshot, { sessionName: SESSION });
    const issues = validateReviewQueueBinding(binding, mutateFirstValue(snapshot));
    assert.deepEqual(codes(issues), ["snapshot-hash-mismatch"]);
    assert.throws(
      () => assertReviewQueueBinding(binding, mutateFirstValue(snapshot)),
      (error: unknown) => error instanceof UnattestedReviewQueueError,
    );
  });

  it("names a removed item: walking only what is present cannot notice a removal", () => {
    const snapshot = openQueue();
    const removedName = snapshot.items[0]!.metadata.name;
    const binding = bindReviewQueue(snapshot, { sessionName: SESSION });
    const issues = validateReviewQueueBinding(binding, dropFirstItem(snapshot));
    assert.ok(issues.some((issue) => issue.code === "item-removed" && issue.itemName === removedName));
    assert.ok(issues.some((issue) => issue.code === "snapshot-hash-mismatch"));
  });

  it("names an added item: the reverse direction is a different edit", () => {
    const snapshot = openQueue();
    const binding = bindReviewQueue(snapshot, { sessionName: SESSION });
    const smuggled = structuredClone(snapshot.items[0]!) as ReviewItem;
    smuggled.metadata.name = "smuggled-after-open";
    const issues = validateReviewQueueBinding(binding, { ...snapshot, items: [...snapshot.items, smuggled] });
    assert.ok(issues.some((issue) => issue.code === "item-added" && issue.itemName === "smuggled-after-open"));
    assert.ok(issues.some((issue) => issue.code === "snapshot-hash-mismatch"));
  });

  it("refuses an emptied queue rather than passing it vacuously", () => {
    const snapshot = openQueue();
    const binding = bindReviewQueue(snapshot, { sessionName: SESSION });
    const issues = validateReviewQueueBinding(binding, { ...snapshot, items: [], activeItemName: "" });
    assert.ok(issues.some((issue) => issue.code === "empty-queue"));
    assert.equal(issues.filter((issue) => issue.code === "item-removed").length, snapshot.items.length);
  });

  it("refuses a binding naming a different session", () => {
    const snapshot = openQueue();
    const binding = bindReviewQueue(snapshot, { sessionName: "some-other-session" });
    assert.deepEqual(codes(validateReviewQueueBinding(binding, snapshot, { sessionName: SESSION })), ["session-name-mismatch"]);
  });

  it("fails closed on a malformed binding instead of skipping the checks it cannot run", () => {
    const snapshot = openQueue();
    const binding = bindReviewQueue(snapshot, { sessionName: SESSION });
    const malformed: unknown[] = [
      { ...binding, kind: "SomethingElse" },
      { ...binding, spec: { ...binding.spec, snapshotHash: "not-a-hash" } },
      { ...binding, spec: { ...binding.spec, sessionName: "" } },
      { ...binding, spec: { ...binding.spec, itemNames: [] } },
      { ...binding, spec: { ...binding.spec, itemNames: [...binding.spec.itemNames].reverse() } },
      { ...binding, spec: { ...binding.spec, itemNames: [binding.spec.itemNames[0], binding.spec.itemNames[0]] } },
      { ...binding, spec: { ...binding.spec, boundAt: "" } },
      null,
      [],
    ];
    for (const candidate of malformed) {
      const issues = validateReviewQueueBinding(candidate as ReviewQueueBinding, snapshot);
      assert.deepEqual(codes(issues), ["binding-malformed"], JSON.stringify(candidate)?.slice(0, 80));
    }
  });

  it("cannot, by itself, catch an edit that also re-binds — that is the extraction side's job", () => {
    // The honest statement of the limit: hashing mutated bytes yields a
    // self-consistent pair, which is exactly why bindReviewQueue must run at
    // open and never at save. The coordinated rewrite is caught below, by the
    // artifact the queue was not derived from.
    const mutated = mutateFirstValue(openQueue());
    const rebound = bindReviewQueue(mutated, { sessionName: SESSION });
    assert.deepEqual(validateReviewQueueBinding(rebound, mutated, { sessionName: SESSION }), []);

    const importResult = buildEnvelopeImportFixture();
    const issues = validateReviewQueueAgainstExtractionImport(mutated.items, importResult);
    assert.deepEqual(codes(issues), ["item-diverges-from-extraction"]);
  });
});

describe("validateReviewQueueAgainstExtractionImport", () => {
  it("attests the honest whole-extraction queue", () => {
    const importResult = buildEnvelopeImportFixture();
    const snapshot = openQueue();
    assert.deepEqual(validateReviewQueueAgainstExtractionImport(snapshot.items, importResult), []);
    assert.doesNotThrow(() => assertReviewQueueAgainstExtractionImport(snapshot.items, importResult));
  });

  it("refuses a queue missing an extracted item", () => {
    const importResult = buildEnvelopeImportFixture();
    const snapshot = dropFirstItem(openQueue());
    const issues = validateReviewQueueAgainstExtractionImport(snapshot.items, importResult);
    assert.deepEqual(codes(issues), ["item-missing-from-queue"]);
  });

  it("refuses a queue carrying an item the extraction never produced", () => {
    const importResult = buildEnvelopeImportFixture();
    const snapshot = openQueue();
    const foreign = structuredClone(snapshot.items[0]!) as ReviewItem;
    foreign.metadata.name = "never-extracted";
    const issues = validateReviewQueueAgainstExtractionImport([...snapshot.items, foreign], importResult);
    assert.deepEqual(codes(issues), ["item-not-in-extraction"]);
  });

  it("refuses a stored item whose bytes diverge from the extraction", () => {
    const importResult = buildEnvelopeImportFixture();
    const mutated = mutateFirstValue(openQueue());
    const issues = validateReviewQueueAgainstExtractionImport(mutated.items, importResult);
    assert.deepEqual(codes(issues), ["item-diverges-from-extraction"]);
  });

  it("refuses an emptied queue: there is nothing it can certify", () => {
    const importResult = buildEnvelopeImportFixture();
    const issues = validateReviewQueueAgainstExtractionImport([], importResult);
    assert.deepEqual(codes(issues), ["empty-queue"]);
  });

  it("refuses an import that is not grounded, and throws on one whose status was forged", () => {
    // A genuinely ungrounded import: the prepared artifact reports a digest
    // mismatch, so the import boundary records diagnostics and no ReviewItems.
    const ungrounded = ungroundedImportFixture();
    assert.equal(ungrounded.record.status.state, "unresolved");
    const issues = validateReviewQueueAgainstExtractionImport(openQueue().items, ungrounded);
    assert.deepEqual(codes(issues), ["import-not-grounded"]);

    // A FORGED status — grounded flipped by hand — does not even reach the
    // issue list: the import boundary's own revalidation throws first, which
    // is the fail-closed order this check leans on.
    const importResult = buildEnvelopeImportFixture();
    const record = structuredClone(importResult.record);
    (record.status as { state: string }).state = "unresolved";
    assert.throws(
      () => validateReviewQueueAgainstExtractionImport(openQueue().items, { ...importResult, record }),
      /Import status does not match envelope state/,
    );
  });

  it("blesses a coordinated record rewrite — the pinned boundary: consistency, not record integrity", () => {
    // The reviewer's construction against PR #222: edit the stored record's
    // candidateValue, re-derive the queue items from the edited record,
    // re-bind. Both checks pass, because nothing in the record lets a library
    // verify proposal bytes against the prepared artifact — the envelope
    // carries the artifact's digest, never its bytes.
    const honest = buildEnvelopeImportFixture();
    const edited = structuredClone(honest.record);
    const proposal = edited.spec.envelope.result.proposals[0]!;
    assert.notEqual(proposal.candidateValue, "substituted-by-coordinated-rewrite");
    proposal.candidateValue = "substituted-by-coordinated-rewrite";

    // The edited record still revalidates as grounded: proposal bytes are not
    // covered by any digest the import boundary can check.
    assert.equal(validateExtractionEnvelopeImport(edited).status.state, "grounded");

    // And the prepared-artifact digest is UNCHANGED — it still names the
    // honest bytes. That digest is the caller's hook: binding the prepared
    // artifact's bytes to it on every read is what makes this rewrite
    // detectable, and it is a storage obligation this library cannot take
    // over. This assertion is what "a third artifact disagrees" traces to.
    assert.equal(
      edited.spec.envelope.result.preparedArtifact!.digest,
      honest.record.spec.envelope.result.preparedArtifact!.digest,
    );

    const items = buildReviewItemsFromExtractionEnvelopeImport(edited);
    const snapshot = initialReviewQueueSessionState(items);
    const rebound = bindReviewQueue(snapshot, { sessionName: SESSION });

    // The binding side is blind by documentation (re-bound mutated bytes are
    // self-consistent) ...
    assert.deepEqual(validateReviewQueueBinding(rebound, snapshot, { sessionName: SESSION }), []);

    // ... and the cross-check BLESSES the pair: the queue is exactly what the
    // presented record derives, and consistency is all it claims. THE PASS
    // ASSERTED ON THE NEXT LINE IS THE BOUNDARY. If it goes red, enforcement
    // moved: rewrite the module doc, the consumer guide's "What neither side
    // catches", and the upgrade guide's 2.4.0 scoping in the same change.
    // scripts/check-guards.mjs pins this line — removing or rewording it is a
    // matrix failure, and inverting it must turn this suite red.
    assert.deepEqual(validateReviewQueueAgainstExtractionImport(items, { record: edited, reviewItems: items }), []);
    assert.doesNotThrow(() => assertReviewQueueAgainstExtractionImport(items, { record: edited, reviewItems: items }));
  });
});

describe("deriveServerReviewSessionApplyResult with a binding", () => {
  it("refuses a record rebuilt from a mutated snapshot — the self-agreement bypass", () => {
    // The record's own snapshotHash is recomputed at record construction, so a
    // record rebuilt from mutated bytes agrees with itself and passes the
    // freshness check. That is fieldwork#60's original critical, and it is why
    // the binding must come from storage rather than be derived at call time.
    const snapshot = openQueue();
    const binding = bindReviewQueue(snapshot, { sessionName: SESSION });
    const mutated = mutateFirstValue(snapshot);
    const selfAgreeingRecord = createServerReviewSessionRecord({
      sessionName: SESSION,
      snapshot: mutated,
      eventCount: 0,
      updatedAt: new Date(0),
    });

    // Without the binding: the mutation is invisible. This is the documented
    // hole the binding exists to close, asserted so it cannot silently change.
    const derived = deriveServerReviewSessionApplyResult({
      record: selfAgreeingRecord,
      events: [],
      requiredResolvedItems: "none",
    });
    assert.equal(derived.ok, true);

    assert.throws(
      () => deriveServerReviewSessionApplyResult({
        record: selfAgreeingRecord,
        events: [],
        requiredResolvedItems: "none",
        binding,
      }),
      (error: unknown) => error instanceof UnattestedReviewQueueError,
    );
  });

  it("checks the caller's current snapshot against the binding too", () => {
    const snapshot = openQueue();
    const binding = bindReviewQueue(snapshot, { sessionName: SESSION });
    const record = createServerReviewSessionRecord({
      sessionName: SESSION,
      snapshot,
      eventCount: 0,
      updatedAt: new Date(0),
    });

    assert.throws(
      () => deriveServerReviewSessionApplyResult({
        record,
        events: [],
        requiredResolvedItems: "none",
        binding,
        currentSnapshot: mutateFirstValue(snapshot),
        currentEventCount: 0,
      }),
      (error: unknown) => error instanceof UnattestedReviewQueueError,
    );
  });

  it("replays fieldwork#60's closing table end to end", () => {
    const importResult = buildEnvelopeImportFixture();
    const snapshot = openQueue();
    const binding = bindReviewQueue(snapshot, { sessionName: SESSION });
    const record = (queue: ReviewQueueSessionState) => createServerReviewSessionRecord({
      sessionName: SESSION,
      snapshot: queue,
      eventCount: 0,
      updatedAt: new Date(0),
    });
    const serve = (queue: ReviewQueueSessionState) => deriveServerReviewSessionApplyResult({
      record: record(queue),
      events: [],
      requiredResolvedItems: "none",
      binding,
    });

    // honest control: derives, and the extraction side agrees.
    assert.equal(serve(snapshot).ok, true);
    assert.deepEqual(validateReviewQueueAgainstExtractionImport(snapshot.items, importResult), []);

    // drop one item (+ rebuilt record): REFUSED.
    assert.throws(() => serve(dropFirstItem(snapshot)), (error: unknown) => error instanceof UnattestedReviewQueueError);

    // emptied queue: REFUSED.
    assert.throws(
      () => serve({ ...snapshot, items: [], activeItemName: "" }),
      (error: unknown) => error instanceof UnattestedReviewQueueError,
    );

    // coordinated queue rewrite + re-bind: the binding side is blind to it,
    // the extraction side refuses.
    const mutated = mutateFirstValue(snapshot);
    const rebound = bindReviewQueue(mutated, { sessionName: SESSION });
    assert.equal(deriveServerReviewSessionApplyResult({
      record: record(mutated),
      events: [],
      requiredResolvedItems: "none",
      binding: rebound,
    }).ok, true);
    assert.throws(
      () => assertReviewQueueAgainstExtractionImport(mutated.items, importResult),
      /does not match the extraction/,
    );
  });
});
