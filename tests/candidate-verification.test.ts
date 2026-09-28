import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it, mock } from "node:test";
import {
  buildCandidateVerification,
  DEFAULT_SUPPORT_VERIFIER_TIMEOUT_MS,
  foldCandidateVerifications,
  runSupportVerifier,
  validateCandidateVerification,
  valueDigest,
  type BuildCandidateVerificationInput,
  type SupportVerdict,
  type SupportVerificationInput,
  type SupportVerifier,
} from "../src/index.js";

const input: SupportVerificationInput = {
  candidateId: "fee.proposed",
  value: 48000,
  valueType: "number",
  evidence: [
    { id: "ev-2", excerpt: "Summary Fee: 48000", locator: "chars:21-39" },
    { id: "ev-1", excerpt: "Fee: 48000 per year", locator: "chars:0-19", context: "Fee schedule" },
  ],
};

const base: BuildCandidateVerificationInput = {
  input,
  verifier: { id: "fixture-verifier", version: "1.0.0", method: "model" },
  verdict: { result: "supported", score: 0.8 },
  createdAt: "2026-09-28T12:00:00.000Z",
};

/** A test double implementing the port. No model, no network. */
function fakeVerifier(behavior: (input: Readonly<SupportVerificationInput>) => Promise<unknown> | unknown, method: SupportVerifier["method"] = "deterministic"): SupportVerifier {
  return { id: "fake", version: "0.1.0", method, verify: async (given) => behavior(given) as SupportVerdict };
}

const clock = () => "2026-09-28T12:00:00.000Z";

describe("CandidateVerification record", () => {
  it("builds the same id from the same payload, and a different id when any field changes", () => {
    const record = buildCandidateVerification(base);
    assert.equal(buildCandidateVerification(structuredClone(base)).id, record.id);
    assert.match(record.id, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(record.evidenceIds, ["ev-1", "ev-2"]);
    assert.equal(record.valueDigest, valueDigest(48000));

    const variants: Array<[string, BuildCandidateVerificationInput]> = [
      ["candidateId", { ...base, input: { ...input, candidateId: "fee.other" } }],
      ["value", { ...base, input: { ...input, value: 48001 } }],
      ["valueType", { ...base, input: { ...input, valueType: "string" } }],
      ["evidence id", { ...base, input: { ...input, evidence: [{ ...input.evidence[0]!, id: "ev-3" }, input.evidence[1]!] } }],
      ["evidence excerpt", { ...base, input: { ...input, evidence: [{ ...input.evidence[0]!, excerpt: "Summary Fee: 4800" }, input.evidence[1]!] } }],
      ["evidence context", { ...base, input: { ...input, evidence: [input.evidence[0]!, { ...input.evidence[1]!, context: "other" }] } }],
      ["verifier id", { ...base, verifier: { ...base.verifier, id: "other" } }],
      ["verifier version", { ...base, verifier: { ...base.verifier, version: "1.0.1" } }],
      ["method", { ...base, verifier: { ...base.verifier, method: "deterministic" } }],
      ["result", { ...base, verdict: { result: "contradicted", score: 0.8 } }],
      ["score", { ...base, verdict: { result: "supported", score: 0.7 } }],
      ["no score", { ...base, verdict: { result: "supported" } }],
      ["abstain reason", { ...base, verdict: { result: "abstain", abstainReason: "timeout" } }],
      ["createdAt", { ...base, createdAt: "2026-09-28T12:00:01.000Z" }],
    ];
    const ids = new Set([record.id]);
    for (const [label, variant] of variants) {
      const id = buildCandidateVerification(variant).id;
      assert.notEqual(id, record.id, `${label} must change the id`);
      ids.add(id);
    }
    assert.equal(ids.size, variants.length + 1);
  });

  it("is frozen and never defaults a score", () => {
    const record = buildCandidateVerification({ ...base, verdict: { result: "supported" } });
    assert.equal("score" in record, false);
    assert.ok(Object.isFrozen(record) && Object.isFrozen(record.verifier) && Object.isFrozen(record.evidenceIds));
    assert.throws(() => { (record as { result: string }).result = "contradicted"; }, TypeError);
  });

  it("refuses verdicts that mix an abstention with a pass or fail", () => {
    assert.throws(() => buildCandidateVerification({ ...base, verdict: { result: "abstain" } as unknown as SupportVerdict }), /abstainReason/);
    assert.throws(() => buildCandidateVerification({ ...base, verdict: { result: "supported", abstainReason: "error" } as unknown as SupportVerdict }), /only allowed when result is abstain/);
    assert.throws(() => buildCandidateVerification({ ...base, verdict: { result: "abstain", abstainReason: "error", score: 0.1 } as unknown as SupportVerdict }), /no score/);
    assert.throws(() => buildCandidateVerification({ ...base, verdict: { result: "supported", score: 1.5 } }), /score/);
    assert.throws(() => buildCandidateVerification({ ...base, input: { ...input, evidence: [] } }), /non-empty/);
    assert.throws(() => buildCandidateVerification({ ...base, input: { ...input, evidence: [input.evidence[0]!, { ...input.evidence[0]! }] } }), /repeated/);
  });
});

describe("validateCandidateVerification (reload)", () => {
  const record = buildCandidateVerification(base);
  const reloaded = () => JSON.parse(JSON.stringify(record)) as Record<string, unknown>;

  it("accepts a record round-tripped through JSON", () => {
    assert.deepEqual(validateCandidateVerification(reloaded()), record);
  });

  it("rejects an abstention rewritten as a pass", () => {
    const abstained = JSON.parse(JSON.stringify(buildCandidateVerification({ ...base, verdict: { result: "abstain", abstainReason: "timeout" } })));
    assert.equal(validateCandidateVerification(abstained).result, "abstain");
    delete abstained.abstainReason;
    abstained.result = "supported";
    assert.throws(() => validateCandidateVerification(abstained), /id is not the digest/);
  });

  it("rejects edited and inconsistent records", () => {
    const cases: Array<[string, (r: Record<string, any>) => void, RegExp]> = [
      ["result flipped under the old id", (r) => { r.result = "contradicted"; }, /id is not the digest/],
      ["valueDigest swapped", (r) => { r.valueDigest = valueDigest(1); }, /id is not the digest/],
      ["verifier renamed", (r) => { r.verifier.id = "trusted"; }, /id is not the digest/],
      ["id replaced", (r) => { r.id = `sha256:${"0".repeat(64)}`; }, /id is not the digest/],
      ["extra verifier field", (r) => { r.verifier.trusted = true; }, /verifier has an unknown field/],
      ["unknown field", (r) => { r.trusted = true; }, /unknown field trusted/],
      ["abstain without reason", (r) => { r.result = "abstain"; delete r.score; }, /abstainReason/],
      ["pass with abstain reason", (r) => { r.abstainReason = "error"; }, /only allowed when result is abstain/],
      ["unsorted evidence", (r) => { r.evidenceIds = ["ev-2", "ev-1"]; }, /sorted and unique/],
      ["non-canonical timestamp", (r) => { r.createdAt = "2026-09-28"; }, /canonical ISO/],
      ["bad digest", (r) => { r.inputDigest = "sha256:abc"; }, /inputDigest/],
    ];
    for (const [label, mutate, error] of cases) {
      const forged = reloaded();
      mutate(forged);
      assert.throws(() => validateCandidateVerification(forged), error, label);
    }
  });
});

describe("foldCandidateVerifications", () => {
  const record = buildCandidateVerification(base);

  it("applies a record bound to the candidate's current value", () => {
    const fold = foldCandidateVerifications({ candidateId: "fee.proposed", value: 48000 }, [record, JSON.parse(JSON.stringify(record))]);
    assert.equal(fold.status, "evaluated");
    assert.deepEqual(fold.applicable.map(({ id }) => id), [record.id], "a replayed record folds once");
    assert.deepEqual(fold.inapplicable, []);
  });

  it("refuses a record whose valueDigest does not match the candidate value", () => {
    const fold = foldCandidateVerifications({ candidateId: "fee.proposed", value: 52000 }, [record]);
    assert.equal(fold.status, "not-evaluated");
    assert.deepEqual(fold.applicable, []);
    assert.deepEqual(fold.inapplicable.map(({ reason }) => reason), ["value-changed"]);
  });

  it("makes previously matching records inapplicable once the value is edited", () => {
    const before = foldCandidateVerifications({ candidateId: "fee.proposed", value: 48000 }, [record]);
    const edited = foldCandidateVerifications({ candidateId: "fee.proposed", value: "48000" }, [record]);
    assert.equal(before.status, "evaluated");
    assert.equal(edited.status, "not-evaluated", "a string edit of a number is a different value");
    assert.deepEqual(edited.inapplicable.map(({ reason }) => reason), ["value-changed"]);
  });

  it("binds to the full input when the evidence is supplied", () => {
    const same = foldCandidateVerifications({ candidateId: "fee.proposed", value: 48000, valueType: "number", evidence: input.evidence }, [record]);
    assert.equal(same.status, "evaluated");
    const changed = foldCandidateVerifications({ candidateId: "fee.proposed", value: 48000, valueType: "number", evidence: [input.evidence[0]!] }, [record]);
    assert.deepEqual(changed.inapplicable.map(({ reason }) => reason), ["input-changed"]);
  });

  it("keeps other candidates' records and invalid records out, without throwing", () => {
    const other = buildCandidateVerification({ ...base, input: { ...input, candidateId: "fee.other" } });
    const forged = { ...JSON.parse(JSON.stringify(record)), result: "contradicted" };
    const fold = foldCandidateVerifications({ candidateId: "fee.proposed", value: 48000 }, [other, forged, null]);
    assert.equal(fold.status, "not-evaluated");
    assert.deepEqual(fold.inapplicable.map(({ reason }) => reason), ["other-candidate"]);
    assert.deepEqual(fold.rejected.map(({ index }) => index), [1, 2]);
  });

  it("reads an abstention as recorded, never as absent, evaluated or supported", () => {
    const abstained = buildCandidateVerification({ ...base, verdict: { result: "abstain", abstainReason: "error" } });
    const fold = foldCandidateVerifications({ candidateId: "fee.proposed", value: 48000 }, [abstained]);
    assert.equal(fold.status, "abstained");
    assert.equal(foldCandidateVerifications({ candidateId: "fee.proposed", value: 48000 }, [abstained, record]).status, "evaluated", "one verdict beside an abstention is evaluated");
    assert.equal(fold.applicable[0]!.result, "abstain");
    assert.equal(foldCandidateVerifications({ candidateId: "fee.proposed", value: 48000 }, []).status, "not-evaluated");
  });
});

describe("runSupportVerifier through the port", () => {
  it("records a fake verifier's verdict with its identity and the exact input", async () => {
    let seen: Readonly<SupportVerificationInput> | undefined;
    const record = await runSupportVerifier(fakeVerifier((given) => {
      seen = given;
      return { result: "contradicted" };
    }), input, { now: clock });
    assert.equal(record.result, "contradicted");
    assert.deepEqual(record.verifier, { id: "fake", version: "0.1.0" });
    assert.equal(record.method, "deterministic");
    assert.equal("score" in record, false);
    assert.ok(seen && Object.isFrozen(seen), "the verifier gets a frozen copy of the input");
    assert.equal(validateCandidateVerification(JSON.parse(JSON.stringify(record))).id, record.id);
  });

  it("honours a verifier's own abstention", async () => {
    const record = await runSupportVerifier(fakeVerifier(() => ({ result: "abstain", abstainReason: "unsupported" })), input, { now: clock });
    assert.equal(record.result, "abstain");
    assert.equal(record.abstainReason, "unsupported");
  });

  const failures: Array<[string, (input: Readonly<SupportVerificationInput>) => unknown, string]> = [
    ["throws", () => { throw new Error("model unavailable"); }, "error"],
    ["rejects", () => Promise.reject(new Error("503")), "error"],
    ["returns nothing", () => undefined, "empty"],
    ["returns null", () => null, "empty"],
    ["returns a string", () => "supported", "malformed"],
    ["returns an unknown result", () => ({ result: "pass" }), "malformed"],
    ["returns an out-of-range score", () => ({ result: "supported", score: 7 }), "malformed"],
    ["returns an unknown field", () => ({ result: "supported", trusted: true }), "malformed"],
    ["abstains without a reason", () => ({ result: "abstain" }), "malformed"],
  ];
  for (const [label, behavior, reason] of failures) {
    it(`abstains with ${reason} when the verifier ${label}, never records a pass`, async () => {
      const record = await runSupportVerifier(fakeVerifier(behavior), input, { now: clock });
      assert.equal(record.result, "abstain");
      assert.equal(record.abstainReason, reason);
      assert.equal("score" in record, false);
    });
  }

  it("abstains with timeout when the verifier does not answer in time, and aborts it", async () => {
    let aborted = false;
    const hanging: SupportVerifier = {
      id: "slow", version: "1", method: "model",
      verify: (_given, options) => new Promise(() => { options?.signal?.addEventListener("abort", () => { aborted = true; }); }),
    };
    const record = await runSupportVerifier(hanging, input, { now: clock, timeoutMs: 10 });
    assert.equal(record.result, "abstain");
    assert.equal(record.abstainReason, "timeout");
    assert.equal(aborted, true);
  });

  it("bounds the wait by default: a hung verifier abstains with timeout after the default", async () => {
    assert.equal(DEFAULT_SUPPORT_VERIFIER_TIMEOUT_MS, 30_000);
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let settled = false;
      const pending = runSupportVerifier(fakeVerifier(() => new Promise(() => undefined)), input, { now: clock }).then((record) => { settled = true; return record; });
      const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
      await flush();
      mock.timers.tick(DEFAULT_SUPPORT_VERIFIER_TIMEOUT_MS - 1);
      await flush();
      assert.equal(settled, false, "still waiting just before the default");
      mock.timers.tick(1);
      await flush();
      assert.equal(settled, true, "abstains at the default timeout");
      const record = await pending;
      assert.equal(record.result, "abstain");
      assert.equal(record.abstainReason, "timeout");
    } finally {
      mock.timers.reset();
    }
  });

  it("refuses a verifier with no usable identity rather than recording an anonymous verdict", async () => {
    await assert.rejects(runSupportVerifier({ ...fakeVerifier(() => ({ result: "supported" })), id: "" }, input), /verifier.id/);
    await assert.rejects(runSupportVerifier({ ...fakeVerifier(() => ({ result: "supported" })), method: "oracle" as never }, input), /verifier.method/);
  });
});

describe("valueDigest matches Surface", () => {
  it("equals Surface's valueDigest for every value in the shared fixture", async () => {
    const fixture = JSON.parse(await readFile(new URL("../../tests/fixtures/surface-value-digest.v1.json", import.meta.url), "utf8")) as {
      cases: Array<{ name: string; value: unknown; valueDigest: string }>;
    };
    assert.ok(fixture.cases.length >= 10);
    for (const entry of fixture.cases) assert.equal(valueDigest(entry.value), entry.valueDigest, entry.name);
    // Pinned literal next to the derived check.
    assert.equal(valueDigest("Alpha"), "sha256:ec2017d5496abcafbc99601b6c234858fa3fa479fccf64a3823040ddf74e2cfe");
    const byName = new Map(fixture.cases.map((entry) => [entry.name, entry.valueDigest]));
    assert.equal(byName.get("nested object"), byName.get("key order variant"), "key order does not change the digest");
  });
});
