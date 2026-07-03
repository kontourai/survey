import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReviewSessionEvents,
  initialReviewQueueSessionState,
  replayReviewSessionEvents,
} from "../src/review-workbench/review-workbench.js";
import {
  applyReviewSession,
  assertServerReviewSessionEvents,
  assertServerReviewSessionFreshness,
  compareServerReviewSessionFreshness,
  createServerReviewSessionRecord,
  currentSessionState,
  deriveServerReviewSessionApplyResult,
  hashReviewSessionSnapshot,
  ServerReviewSessionEventValidationError,
  StaleServerReviewSessionError,
  validateServerReviewSessionEvents,
} from "../src/review-workbench/server-review-session.js";
import { publicDirectoryReviewItemExample } from "../example-data/public-directory-review-resource.js";
import type { ReviewItem, ReviewSessionEvent } from "../src/review-resource.js";

describe("server-owned review sessions", () => {
  it("hashes snapshots stably across JSON and Date round trips", () => {
    const snapshot = {
      ...initialReviewQueueSessionState([{
        ...publicDirectoryReviewItemExample,
        metadata: {
          ...publicDirectoryReviewItemExample.metadata,
          producer: {
            observedAt: new Date("2026-06-05T12:34:56.000Z"),
            nested: {
              b: 2,
              a: 1,
            },
          },
        },
      }]),
      reviewedAt: "2026-06-05T12:34:56.000Z",
    };
    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;

    assert.equal(hashReviewSessionSnapshot(snapshot), hashReviewSessionSnapshot(roundTripped));
    const orderedSnapshot = {
      items: snapshot.items,
      activeItemName: snapshot.activeItemName,
      notesByItemName: snapshot.notesByItemName,
      decisionsByItemName: snapshot.decisionsByItemName,
      reviewedAt: snapshot.reviewedAt,
      actorId: snapshot.actorId,
    };
    const differentlyOrderedSnapshot = {
      actorId: snapshot.actorId,
      reviewedAt: snapshot.reviewedAt,
      decisionsByItemName: snapshot.decisionsByItemName,
      notesByItemName: snapshot.notesByItemName,
      activeItemName: snapshot.activeItemName,
      items: snapshot.items,
    };

    assert.equal(
      hashReviewSessionSnapshot(orderedSnapshot),
      hashReviewSessionSnapshot(differentlyOrderedSnapshot),
    );
  });

  it("creates typed server records without taking ownership of storage", () => {
    const snapshot = initialReviewQueueSessionState();
    const record = createServerReviewSessionRecord({
      sessionName: "server-review-1",
      snapshot,
      eventCount: 2,
      updatedAt: new Date("2026-06-06T00:00:00.000Z"),
    });

    assert.equal(record.sessionName, "server-review-1");
    assert.equal(record.snapshot, snapshot);
    assert.equal(record.snapshotHash, hashReviewSessionSnapshot(snapshot));
    assert.equal(record.eventCount, 2);
    assert.equal(record.updatedAt, "2026-06-06T00:00:00.000Z");
  });

  it("compares and asserts freshness by snapshot hash and event count", () => {
    const snapshot = initialReviewQueueSessionState();
    const record = createServerReviewSessionRecord({
      sessionName: "server-review-1",
      snapshot,
      eventCount: 2,
      updatedAt: "2026-06-06T00:00:00.000Z",
    });

    assert.deepEqual(compareServerReviewSessionFreshness(record, snapshot, 2), {
      status: "current",
      expectedSnapshotHash: record.snapshotHash,
      actualSnapshotHash: record.snapshotHash,
      expectedEventCount: 2,
      actualEventCount: 2,
    });

    const changedSnapshot = { ...snapshot, actorId: "different-reviewer" };
    const stale = compareServerReviewSessionFreshness(record, changedSnapshot, 3);

    assert.equal(stale.status, "stale");
    assert.throws(
      () => assertServerReviewSessionFreshness(record, changedSnapshot, 3),
      (error: unknown) => {
        assert.ok(error instanceof StaleServerReviewSessionError);
        assert.deepEqual(error.issues.map((issue) => issue.code), [
          "snapshot-hash-mismatch",
          "event-count-mismatch",
        ]);
        return true;
      },
    );
  });

  it("allows freshness checks that only compare the server-owned snapshot", () => {
    const snapshot = initialReviewQueueSessionState();
    const record = createServerReviewSessionRecord({
      sessionName: "server-review-1",
      snapshot,
      updatedAt: "2026-06-06T00:00:00.000Z",
    });

    assert.deepEqual(compareServerReviewSessionFreshness(record, snapshot), {
      status: "current",
      expectedSnapshotHash: record.snapshotHash,
      actualSnapshotHash: record.snapshotHash,
      expectedEventCount: undefined,
      actualEventCount: undefined,
    });
    assert.doesNotThrow(() => assertServerReviewSessionFreshness(record, snapshot));
  });

  it("validates server-owned events against session name and snapshot containment", () => {
    const snapshot = {
      ...initialReviewQueueSessionState([publicDirectoryReviewItemExample]),
      decisionsByItemName: {
        [publicDirectoryReviewItemExample.metadata.name]: "accept-proposed" as const,
      },
    };
    const record = createServerReviewSessionRecord({
      sessionName: "server-review-1",
      snapshot,
      eventCount: 0,
      updatedAt: "2026-06-06T00:00:00.000Z",
    });
    const [event] = buildReviewSessionEvents(snapshot, "other-session");
    assert.ok(event);

    const invalidCandidateEvent = withSpec(event, {
      sessionName: "server-review-1",
      sequence: 2,
      eventType: "decision-submitted",
      reviewItemName: publicDirectoryReviewItemExample.metadata.name,
      candidateId: "not-in-snapshot",
      status: "verified",
      data: {
        workbenchDecision: "accept-proposed",
      },
    });

    const issues = validateServerReviewSessionEvents(record, [event, invalidCandidateEvent]);

    assert.deepEqual(issues.map((issue) => issue.code), [
      "session-name-mismatch",
      "unknown-candidate",
    ]);
    assert.throws(
      () => assertServerReviewSessionEvents(record, [event, invalidCandidateEvent]),
      (error: unknown) => {
        assert.ok(error instanceof ServerReviewSessionEventValidationError);
        assert.equal(error.issues.length, 2);
        return true;
      },
    );
  });

  it("rejects non-canonical event sequences before server apply", () => {
    const snapshot = initialReviewQueueSessionState();
    const record = createServerReviewSessionRecord({
      sessionName: "server-review-1",
      snapshot,
      updatedAt: "2026-06-06T00:00:00.000Z",
    });
    const [started, selected] = buildReviewSessionEvents(snapshot, "server-review-1");
    assert.ok(started);
    assert.ok(selected);

    const duplicate = withSpec(selected, { sequence: 1 });
    const skipped = withSpec(selected, { sequence: 3 });
    const invalid = withSpec(selected, { sequence: 0 });

    assert.deepEqual(
      validateServerReviewSessionEvents(record, [started, duplicate]).map((issue) => issue.code),
      ["duplicate-sequence", "non-contiguous-sequence"],
    );
    assert.deepEqual(
      validateServerReviewSessionEvents(record, [started, skipped]).map((issue) => issue.code),
      ["non-contiguous-sequence"],
    );
    assert.deepEqual(
      validateServerReviewSessionEvents(record, [invalid]).map((issue) => issue.code),
      ["invalid-sequence"],
    );
  });

  it("derives server apply results after freshness and event validation", () => {
    const snapshot = initialReviewQueueSessionState();
    const reviewedSession = {
      ...snapshot,
      decisionsByItemName: {
        [publicDirectoryReviewItemExample.metadata.name]: "accept-proposed" as const,
      },
    };
    const record = createServerReviewSessionRecord({
      sessionName: "server-review-1",
      snapshot,
      updatedAt: "2026-06-06T00:00:00.000Z",
    });

    const result = deriveServerReviewSessionApplyResult({
      record,
      currentSnapshot: snapshot,
      events: buildReviewSessionEvents(reviewedSession, "server-review-1"),
      requiredResolvedItems: "any",
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.reviewItemName, publicDirectoryReviewItemExample.metadata.name);
  });

  it("rejects server apply when the stored snapshot hash or event stream is invalid", () => {
    const snapshot = initialReviewQueueSessionState();
    const record = {
      ...createServerReviewSessionRecord({
        sessionName: "server-review-1",
        snapshot,
        updatedAt: "2026-06-06T00:00:00.000Z",
      }),
      snapshotHash: "not-the-stored-snapshot-hash",
    };
    const [event] = buildReviewSessionEvents(snapshot, "wrong-session");
    assert.ok(event);

    assert.throws(
      () => deriveServerReviewSessionApplyResult({
        record,
        events: [event],
        requiredResolvedItems: "any",
      }),
      StaleServerReviewSessionError,
    );

    const validRecord = createServerReviewSessionRecord({
      sessionName: "server-review-1",
      snapshot,
      updatedAt: "2026-06-06T00:00:00.000Z",
    });
    assert.throws(
      () => deriveServerReviewSessionApplyResult({
        record: validRecord,
        events: [event],
        requiredResolvedItems: "any",
      }),
      ServerReviewSessionEventValidationError,
    );
  });
});

describe("applyReviewSession one-call apply", () => {
  const itemName = publicDirectoryReviewItemExample.metadata.name;

  function reviewedEvents(sessionName: string, decision = "accept-proposed" as const): readonly ReviewSessionEvent[] {
    const snapshot = initialReviewQueueSessionState([publicDirectoryReviewItemExample]);
    return buildReviewSessionEvents({ ...snapshot, decisionsByItemName: { [itemName]: decision } }, sessionName);
  }

  it("applies a reviewed session and maps results to product actions in one call", () => {
    const snapshot = initialReviewQueueSessionState([publicDirectoryReviewItemExample]);
    const applied = applyReviewSession<{ kind: string; target: string }>({
      snapshot,
      sessionName: "server-review-1",
      events: reviewedEvents("server-review-1"),
      requiredResolvedItems: "any",
      mapActions: {
        map: ({ result, target }) =>
          result.decision === "accept-proposed" ? { kind: "apply-field", target } : undefined,
      },
    });

    assert.equal(applied.ok, true);
    assert.equal(applied.results.length, 1);
    assert.equal(applied.results[0]?.reviewItemName, itemName);
    assert.deepEqual(applied.actions.map((entry) => entry.action), [
      { kind: "apply-field", target: "availabilityStatus" },
    ]);
  });

  it("builds a server record from a session name carried on the events", () => {
    const snapshot = initialReviewQueueSessionState([publicDirectoryReviewItemExample]);
    const applied = applyReviewSession({
      snapshot,
      events: reviewedEvents("server-review-events-name"),
      requiredResolvedItems: "any",
    });

    assert.equal(applied.ok, true);
  });

  it("normalizes a stale server record into a stale-session issue instead of throwing", () => {
    const snapshot = initialReviewQueueSessionState([publicDirectoryReviewItemExample]);
    const record = {
      ...createServerReviewSessionRecord({ sessionName: "server-review-1", snapshot, updatedAt: "2026-06-06T00:00:00.000Z" }),
      snapshotHash: "not-the-stored-snapshot-hash",
    };
    const applied = applyReviewSession({ record, events: reviewedEvents("server-review-1"), requiredResolvedItems: "any" });

    assert.equal(applied.ok, false);
    assert.deepEqual(applied.issues.map((issue) => issue.code), ["stale-session"]);
  });

  it("normalizes invalid events into an invalid-events issue instead of throwing", () => {
    const snapshot = initialReviewQueueSessionState([publicDirectoryReviewItemExample]);
    const applied = applyReviewSession({
      snapshot,
      sessionName: "server-review-1",
      events: reviewedEvents("a-different-session"),
      requiredResolvedItems: "any",
    });

    assert.equal(applied.ok, false);
    assert.deepEqual(applied.issues.map((issue) => issue.code), ["invalid-events"]);
  });

  it("passes derive-level issues through for unresolved required items", () => {
    const snapshot = initialReviewQueueSessionState([publicDirectoryReviewItemExample]);
    const applied = applyReviewSession({
      snapshot,
      sessionName: "server-review-1",
      events: buildReviewSessionEvents(snapshot, "server-review-1"),
      requiredResolvedItems: "all",
    });

    assert.equal(applied.ok, false);
    assert.deepEqual(applied.issues.map((issue) => issue.code), ["unresolved-review-item"]);
  });

  it("reports a decision-mode violation when enforceProducerPolicy is on", () => {
    const enforcedItem: ReviewItem = {
      ...publicDirectoryReviewItemExample,
      spec: {
        ...publicDirectoryReviewItemExample.spec,
        producerPolicy: { decisionMode: "keep-current" },
      },
    };
    const snapshot = initialReviewQueueSessionState([enforcedItem]);
    const events = buildReviewSessionEvents(
      { ...snapshot, decisionsByItemName: { [itemName]: "accept-proposed" as const } },
      "server-review-1",
    );
    const applied = applyReviewSession({
      snapshot,
      sessionName: "server-review-1",
      events,
      requiredResolvedItems: "any",
      enforceProducerPolicy: true,
    });

    assert.equal(applied.ok, false);
    assert.deepEqual(applied.issues.map((issue) => issue.code), ["decision-mode-violation"]);
  });

  it("does not enforce producerPolicy by default", () => {
    const enforcedItem: ReviewItem = {
      ...publicDirectoryReviewItemExample,
      spec: {
        ...publicDirectoryReviewItemExample.spec,
        producerPolicy: { decisionMode: "keep-current" },
      },
    };
    const snapshot = initialReviewQueueSessionState([enforcedItem]);
    const events = buildReviewSessionEvents(
      { ...snapshot, decisionsByItemName: { [itemName]: "accept-proposed" as const } },
      "server-review-1",
    );
    const applied = applyReviewSession({ snapshot, sessionName: "server-review-1", events, requiredResolvedItems: "any" });

    assert.equal(applied.ok, true);
  });

  it("normalizes an action-mapping failure into an action-mapping-failed issue", () => {
    const snapshot = initialReviewQueueSessionState([publicDirectoryReviewItemExample]);
    const applied = applyReviewSession({
      snapshot,
      sessionName: "server-review-1",
      events: reviewedEvents("server-review-1"),
      requiredResolvedItems: "any",
      mapActions: {
        map: () => undefined,
      },
    });

    assert.equal(applied.ok, false);
    assert.deepEqual(applied.issues.map((issue) => issue.code), ["action-mapping-failed"]);
  });
});

function withSpec(
  event: ReviewSessionEvent,
  spec: Partial<ReviewSessionEvent["spec"]>,
): ReviewSessionEvent {
  return {
    ...event,
    spec: {
      ...event.spec,
      ...spec,
    },
  };
}

describe("currentSessionState", () => {
  const itemName = publicDirectoryReviewItemExample.metadata.name;

  it("returns the exact same snapshot reference when events is empty", () => {
    const snapshot = initialReviewQueueSessionState([publicDirectoryReviewItemExample]);

    assert.strictEqual(currentSessionState(snapshot, []), snapshot);
  });

  it("returns the replayed state when events is non-empty, matching replayReviewSessionEvents directly", () => {
    const snapshot = initialReviewQueueSessionState([publicDirectoryReviewItemExample]);
    const events = buildReviewSessionEvents(
      { ...snapshot, decisionsByItemName: { [itemName]: "accept-proposed" as const } },
      "server-review-1",
    );

    assert.deepStrictEqual(
      currentSessionState(snapshot, events),
      replayReviewSessionEvents(snapshot, events),
    );
  });
});
