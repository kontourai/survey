import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  facilityCredentialConsumerExample,
} from "../examples/review-workbench/facility-credential-consumer.js";
import {
  facilityCredentialCurrentRecordFixture,
  prepareFacilityCredentialServerApply,
} from "../examples/review-workbench/server-apply-consumer.js";

describe("generic server apply consumer example", () => {
  it("prepares a product-owned mutation from persisted Survey events", () => {
    const prepared = prepareFacilityCredentialServerApply({
      currentRecord: facilityCredentialCurrentRecordFixture,
      reviewSessionSnapshot: facilityCredentialConsumerExample.reviewSessionSnapshot,
      events: facilityCredentialConsumerExample.persistedEvents,
      actorId: "server-admin@example.test",
      appliedAt: "2026-01-17T17:00:00.000Z",
    });

    assert.equal(prepared.ok, true);
    assert.equal(prepared.mutation.recordId, "facility-credential-record-1");
    assert.equal(prepared.mutation.reviewItemName, facilityCredentialConsumerExample.reviewItem.metadata.name);
    assert.equal(prepared.mutation.actorId, "server-admin@example.test");
    assert.deepEqual(prepared.mutation.credential, prepared.result.selectedValue);
  });

  it("fails closed when persisted events do not replay against the pre-decision snapshot", () => {
    const prepared = prepareFacilityCredentialServerApply({
      currentRecord: facilityCredentialCurrentRecordFixture,
      reviewSessionSnapshot: facilityCredentialConsumerExample.reviewSessionSnapshot,
      events: [],
      actorId: "server-admin@example.test",
      appliedAt: "2026-01-17T17:00:00.000Z",
    });

    assert.equal(prepared.ok, false);
    assert.match(prepared.message, /no resolved review decision|unresolved/i);
  });

  it("keeps product current-state validation outside Survey", () => {
    const prepared = prepareFacilityCredentialServerApply({
      currentRecord: {
        ...facilityCredentialCurrentRecordFixture,
        credential: { licenseNumber: "changed-after-review" },
      },
      reviewSessionSnapshot: facilityCredentialConsumerExample.reviewSessionSnapshot,
      events: facilityCredentialConsumerExample.persistedEvents,
      actorId: "server-admin@example.test",
      appliedAt: "2026-01-17T17:00:00.000Z",
    });

    assert.equal(prepared.ok, false);
    assert.match(prepared.message, /no longer matches/i);
  });
});
