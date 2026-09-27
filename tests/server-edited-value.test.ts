import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReviewSessionEvents,
  editedValueFromEditorText,
  initialReviewQueueSessionState,
  type ReviewQueueSessionState,
} from "../src/review-workbench/review-workbench.js";
import { reviewWorkbenchQueueExamples } from "../src/review-workbench/review-workbench-data.js";
import {
  applyReviewSession,
  createServerReviewSessionRecord,
  deriveServerReviewSessionApplyResult,
  ServerReviewSessionEventValidationError,
} from "../src/review-workbench/server-review-session.js";
import type { ReviewItem, ReviewValueDescriptor } from "../src/review-resource.js";
import { buildEnvelopeImportFixture } from "./envelope-review-fixture.js";

// kontourai/survey#278: the server apply boundary enforces the item's
// `editable` flag and `valueDescriptor` on an accept-proposed inline edit,
// instead of trusting whatever `workbenchEditedValue` a client sent.

function envelopeNumberItem(): ReviewItem {
  const item = buildEnvelopeImportFixture().reviewItems.find((entry) => entry.spec.valueDescriptor?.type === "number");
  assert.ok(item);
  assert.equal(item.spec.editable, false);
  return item;
}

function editableItem(valueDescriptor: ReviewValueDescriptor): ReviewItem {
  const base = reviewWorkbenchQueueExamples[0]!;
  return { ...base, spec: { ...base.spec, valueDescriptor } };
}

/** Snapshot plus the event stream a client would send after accepting `item` with `editedValue`. */
function acceptWithEdit(item: ReviewItem, editedValue?: unknown) {
  const snapshot = initialReviewQueueSessionState([item]);
  const decided: ReviewQueueSessionState = {
    ...snapshot,
    decisionsByItemName: { [item.metadata.name]: "accept-proposed" },
    editedValuesByItemName: editedValue === undefined ? {} : { [item.metadata.name]: editedValue },
  };
  const events = buildReviewSessionEvents(decided);
  const record = createServerReviewSessionRecord({ sessionName: events[0]!.spec.sessionName, snapshot });
  return { snapshot, events, record };
}

function derivedIssueCodes(item: ReviewItem, editedValue: unknown): string[] {
  const { events, record } = acceptWithEdit(item, editedValue);
  try {
    deriveServerReviewSessionApplyResult({ record, events, requiredResolvedItems: "all" });
  } catch (error) {
    assert.ok(error instanceof ServerReviewSessionEventValidationError, String(error));
    // The workbench emits decision-changed and decision-submitted for one
    // decision, so one bad edit yields one issue per event; compare the set.
    return [...new Set(error.issues.map((issue) => issue.code))];
  }
  return [];
}

describe("editedValueFromEditorText", () => {
  it("converts editor text to the descriptor's JSON type and refuses text that does not parse", () => {
    assert.equal(editedValueFromEditorText({ type: "number" }, " 42 "), 42);
    assert.equal(editedValueFromEditorText({ type: "number" }, "abc"), undefined);
    assert.equal(editedValueFromEditorText({ type: "boolean" }, "false"), false);
    assert.equal(editedValueFromEditorText({ type: "boolean" }, "yes"), undefined);
    assert.equal(editedValueFromEditorText({ type: "date" }, "2026-03-03"), "2026-03-03");
    assert.equal(editedValueFromEditorText({ type: "string" }, " kept as typed "), " kept as typed ");
    assert.equal(editedValueFromEditorText(undefined, "raw"), "raw");
  });
});

describe("server apply: inline edit validation", () => {
  it("refuses an edited value on a non-editable (envelope-imported) item", () => {
    const item = envelopeNumberItem();
    assert.deepEqual(derivedIssueCodes(item, 12345), ["edited-value-not-editable"]);

    const { snapshot, events } = acceptWithEdit(item, "not a number");
    const applied = applyReviewSession({ snapshot, events, requiredResolvedItems: "all" });
    assert.equal(applied.ok, false);
    assert.equal(applied.issues[0]?.code, "invalid-events");
    assert.match(applied.issues[0]?.message ?? "", /not editable/);
  });

  it("still accepts a non-editable item's proposed value when no edit is carried (#201)", () => {
    const item = envelopeNumberItem();
    const { events, record } = acceptWithEdit(item);
    const derived = deriveServerReviewSessionApplyResult({ record, events, requiredResolvedItems: "all" });
    assert.equal(derived.ok, true);
    assert.equal(derived.results[0]?.effectiveValue, item.spec.candidates[0]!.value);
    assert.equal(derived.results[0]?.status, "verified");
  });

  it("refuses an edit that does not satisfy the item's number type", () => {
    const item = editableItem({ type: "number" });
    assert.deepEqual(derivedIssueCodes(item, "abc"), ["edited-value-type-mismatch"]);
    assert.deepEqual(derivedIssueCodes(item, true), ["edited-value-type-mismatch"]);
  });

  it("accepts a JSON number edit on a number item and keeps it a number", () => {
    const item = editableItem({ type: "number" });
    const { events, record } = acceptWithEdit(item, 42);
    const derived = deriveServerReviewSessionApplyResult({ record, events, requiredResolvedItems: "all" });
    assert.equal(derived.ok, true);
    assert.equal(derived.results[0]?.effectiveValue, 42);
    assert.equal(typeof derived.results[0]?.effectiveValue, "number");
    assert.deepEqual(derived.warnings, []);
  });

  it("converts a legacy text edit (\"42\") on a number item to 42 and reports a warning", () => {
    // Pinned choice for sessions saved by earlier workbenches, which stored every
    // edit as editor text: text that parses cleanly is converted, with a warning.
    const item = editableItem({ type: "number" });
    const { snapshot, events, record } = acceptWithEdit(item, "42");
    const derived = deriveServerReviewSessionApplyResult({ record, events, requiredResolvedItems: "all" });
    assert.equal(derived.ok, true);
    assert.equal(derived.results[0]?.effectiveValue, 42);
    assert.equal(derived.results[0]?.editedValue, 42);
    // One warning per decision event carrying the edit (decision-changed and
    // decision-submitted).
    assert.equal(derived.warnings?.length, 2);
    assert.ok(derived.warnings?.every((warning) => warning.code === "edited-value-converted-from-text"));
    assert.equal(derived.warnings?.[0]?.originalValue, "42");
    assert.equal(derived.warnings?.[0]?.convertedValue, 42);

    const applied = applyReviewSession({ snapshot, events, requiredResolvedItems: "all" });
    assert.equal(applied.ok, true);
    assert.equal(applied.results[0]?.effectiveValue, 42);
    assert.equal(applied.ok && applied.warnings?.length, 2);
  });

  it("converts legacy boolean text and refuses text outside the descriptor", () => {
    const booleanItem = editableItem({ type: "boolean" });
    const { events, record } = acceptWithEdit(booleanItem, "false");
    const derived = deriveServerReviewSessionApplyResult({ record, events, requiredResolvedItems: "all" });
    assert.equal(derived.ok, true);
    assert.equal(derived.results[0]?.effectiveValue, false);
    assert.deepEqual(derivedIssueCodes(booleanItem, "yes"), ["edited-value-type-mismatch"]);
  });

  it("enforces date shape, declared enum members, and string type", () => {
    assert.deepEqual(derivedIssueCodes(editableItem({ type: "date" }), "March 3"), ["edited-value-type-mismatch"]);
    assert.deepEqual(derivedIssueCodes(editableItem({ type: "date" }), "2026-03-03"), []);
    const enumItem = editableItem({ type: "enum", enumValues: ["open", "closed"] });
    assert.deepEqual(derivedIssueCodes(enumItem, "ajar"), ["edited-value-type-mismatch"]);
    assert.deepEqual(derivedIssueCodes(enumItem, "closed"), []);
    assert.deepEqual(derivedIssueCodes(editableItem({ type: "string" }), 7), ["edited-value-type-mismatch"]);
    assert.deepEqual(derivedIssueCodes(editableItem({ type: "string" }), "Weekdays 7am-7pm"), []);
  });

  it("leaves an editable item with no descriptor unconstrained", () => {
    const base: ReviewItem = reviewWorkbenchQueueExamples[0]!;
    assert.equal(base.spec.valueDescriptor, undefined);
    assert.deepEqual(derivedIssueCodes(base, "Weekdays 7am-7pm"), []);
  });
});
