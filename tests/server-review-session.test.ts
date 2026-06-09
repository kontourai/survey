import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReviewSessionEvents,
  initialReviewQueueSessionState,
} from "../src/review-workbench/review-workbench.js";
import {
  assertServerReviewSessionEvents,
  assertServerReviewSessionFreshness,
  compareServerReviewSessionFreshness,
  createServerReviewSessionRecord,
  hashReviewSessionSnapshot,
  ServerReviewSessionEventValidationError,
  StaleServerReviewSessionError,
  validateServerReviewSessionEvents,
} from "../src/review-workbench/server-review-session.js";
import { publicDirectoryReviewItemFixture } from "../fixtures/public-directory-review-resource.js";
import type { ReviewSessionEvent } from "../src/review-resource.js";

describe("server-owned review sessions", () => {
  it("hashes snapshots stably across JSON and Date round trips", () => {
    const snapshot = {
      ...initialReviewQueueSessionState([{
        ...publicDirectoryReviewItemFixture,
        metadata: {
          ...publicDirectoryReviewItemFixture.metadata,
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
      ...initialReviewQueueSessionState([publicDirectoryReviewItemFixture]),
      decisionsByItemName: {
        [publicDirectoryReviewItemFixture.metadata.name]: "accept-proposed" as const,
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
      reviewItemName: publicDirectoryReviewItemFixture.metadata.name,
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
