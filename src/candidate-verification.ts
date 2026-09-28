import { sha256Hex } from "./sha256.js";

/**
 * Support verification: a port for an independent check of whether a
 * candidate's value is supported by its evidence, and the immutable record of
 * what such a check said.
 *
 * A {@link CandidateVerification} is a record of a verifier's output, bound to
 * the exact value and evidence it checked. It is not a trust decision: nothing
 * in Survey reads it to route, auto-accept, or calibrate a candidate. Survey
 * ships no verifier implementations; producers or separate adapter packages
 * implement {@link SupportVerifier}.
 *
 * Runtime-neutral (no Node built-ins) so the review workbench bundle can
 * validate records in the browser.
 */

export const candidateVerificationKind = "survey.candidate-verification" as const;

export type SupportVerificationMethod = "deterministic" | "model" | "human";
export type SupportVerificationResult = "supported" | "contradicted" | "not-addressed" | "abstain";
export type SupportAbstainReason = "malformed" | "empty" | "timeout" | "unsupported" | "error";

const METHODS: readonly SupportVerificationMethod[] = ["deterministic", "model", "human"];
const RESULTS: readonly SupportVerificationResult[] = ["supported", "contradicted", "not-addressed", "abstain"];
const ABSTAIN_REASONS: readonly SupportAbstainReason[] = ["malformed", "empty", "timeout", "unsupported", "error"];

export interface SupportEvidence {
  id: string;
  excerpt: string;
  locator: string;
  context?: string;
}

export interface SupportVerificationInput {
  candidateId: string;
  value: unknown;
  /** Declared value type when the producer knows it (for example `ReviewValueType`). */
  valueType?: string;
  /** At least one item; ids are unique. */
  evidence: SupportEvidence[];
}

/**
 * What a verifier returns. `score` has no meaning unless a calibration record
 * says otherwise: it is optional, never defaulted, and never feeds a
 * confidence. An abstention carries its reason and no score.
 */
export type SupportVerdict =
  | { result: "supported" | "contradicted" | "not-addressed"; score?: number }
  | { result: "abstain"; abstainReason: SupportAbstainReason };

/** The port. Implementations live with producers or in adapter packages. */
export interface SupportVerifier {
  readonly id: string;
  readonly version: string;
  readonly method: SupportVerificationMethod;
  verify(input: Readonly<SupportVerificationInput>, options?: { signal?: AbortSignal }): Promise<SupportVerdict>;
}

export interface CandidateVerification {
  /** `sha256:` digest of every other field; recomputed on validation. */
  id: string;
  kind: typeof candidateVerificationKind;
  schemaVersion: 1;
  candidateId: string;
  /** Sorted, unique ids of the evidence the verifier was given. */
  evidenceIds: string[];
  /** {@link valueDigest} of the value checked. */
  valueDigest: string;
  /** {@link supportVerificationInputDigest} of the full input checked. */
  inputDigest: string;
  verifier: { id: string; version: string };
  method: SupportVerificationMethod;
  result: SupportVerificationResult;
  /** Present exactly when `result` is `abstain`. */
  abstainReason?: SupportAbstainReason;
  /** Uncalibrated unless a calibration record says otherwise. Never defaulted. */
  score?: number;
  createdAt: string;
}

export interface BuildCandidateVerificationInput {
  input: SupportVerificationInput;
  verifier: { id: string; version: string; method: SupportVerificationMethod };
  verdict: SupportVerdict;
  createdAt: string;
}

/**
 * Canonical JSON with object keys sorted by UTF-16 code unit, matching
 * `canonicalJson` in `@kontourai/surface` (`src/canonical-digest.ts`) byte for
 * byte. Survey's review-workbench `canonicalJson` sorts with `localeCompare`
 * and would disagree on mixed-case keys, so it is not used here.
 */
function surfaceCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(surfaceCanonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${surfaceCanonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/**
 * `"sha256:" + hex SHA-256` of the canonical JSON of a value: the same
 * definition as Surface's `valueDigest`, so a record binds to a value the way a
 * Surface claim does.
 */
export function valueDigest(value: unknown): string {
  return `sha256:${sha256Hex(surfaceCanonicalJson(value))}`;
}

function digest(domain: string, payload: unknown): string {
  return `sha256:${sha256Hex(surfaceCanonicalJson({ domain, payload }))}`;
}

/** Digest of everything a verifier was given: candidate id, value, value type and evidence (ordered by id). */
export function supportVerificationInputDigest(input: SupportVerificationInput): string {
  const normalized = normalizeInput(input);
  return digest("survey.support-verification-input/v1", {
    candidateId: normalized.candidateId,
    valueDigest: valueDigest(normalized.value),
    ...(normalized.valueType !== undefined ? { valueType: normalized.valueType } : {}),
    evidence: normalized.evidence,
  });
}

/**
 * Builds a frozen record from a verifier's verdict. Throws on a malformed
 * verdict: use {@link runSupportVerifier} to turn a verifier's failure into an
 * abstention instead.
 */
export function buildCandidateVerification(input: BuildCandidateVerificationInput): CandidateVerification {
  const normalized = normalizeInput(input.input);
  const verifier = normalizeVerifier(input.verifier);
  const verdict = normalizeVerdict(input.verdict);
  const payload: Omit<CandidateVerification, "id"> = {
    kind: candidateVerificationKind,
    schemaVersion: 1,
    candidateId: normalized.candidateId,
    evidenceIds: normalized.evidence.map(({ id }) => id),
    valueDigest: valueDigest(normalized.value),
    inputDigest: supportVerificationInputDigest(normalized),
    verifier: { id: verifier.id, version: verifier.version },
    method: verifier.method,
    result: verdict.result,
    ...(verdict.result === "abstain" ? { abstainReason: verdict.abstainReason } : {}),
    ...(verdict.result !== "abstain" && verdict.score !== undefined ? { score: verdict.score } : {}),
    createdAt: canonicalTimestamp(input.createdAt, "createdAt"),
  };
  return deepFreeze({ id: recordId(payload), ...payload });
}

export interface RunSupportVerifierOptions {
  /** Abstain with `timeout` when the verifier has not answered by then. */
  timeoutMs?: number;
  /** Clock for `createdAt`; defaults to the current time. */
  now?: () => string;
}

/**
 * Calls a verifier and records what it said. A verifier that throws abstains
 * with `error`, one that returns nothing with `empty`, one that returns a
 * malformed verdict with `malformed`, and one that exceeds `timeoutMs` with
 * `timeout`. None of these ever records a pass or a fail.
 *
 * Throws only for caller errors: a malformed input, or a verifier without a
 * usable identity (a record needs one).
 */
export async function runSupportVerifier(
  verifier: SupportVerifier,
  input: SupportVerificationInput,
  options: RunSupportVerifierOptions = {},
): Promise<CandidateVerification> {
  const identity = normalizeVerifier(verifier);
  const normalized = normalizeInput(input);
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("timeoutMs must be a positive finite number");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const verdict = await callVerifier(verifier, normalized, options.timeoutMs);
  return buildCandidateVerification({ input: normalized, verifier: identity, verdict, createdAt: now() });
}

async function callVerifier(verifier: SupportVerifier, input: SupportVerificationInput, timeoutMs: number | undefined): Promise<SupportVerdict> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timeout");
  // The verifier gets its own frozen copy: it cannot change what the record binds to.
  const frozenInput = deepFreeze(structuredClone(input));
  try {
    const call = Promise.resolve().then(() => verifier.verify(frozenInput, { signal: controller.signal }));
    const raced = timeoutMs === undefined
      ? await call
      : await Promise.race([call, new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), timeoutMs); })]);
    if (raced === timedOut) {
      controller.abort();
      call.catch(() => undefined);
      return { result: "abstain", abstainReason: "timeout" };
    }
    if (raced === undefined || raced === null) return { result: "abstain", abstainReason: "empty" };
    try {
      return normalizeVerdict(raced);
    } catch {
      return { result: "abstain", abstainReason: "malformed" };
    }
  } catch {
    return { result: "abstain", abstainReason: "error" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const RECORD_KEYS = new Set(["id", "kind", "schemaVersion", "candidateId", "evidenceIds", "valueDigest", "inputDigest", "verifier", "method", "result", "abstainReason", "score", "createdAt"]);

/**
 * Validates a record read back from storage and returns a frozen copy. Throws
 * on any unknown field, inconsistent verdict, or an id that is not the digest
 * of the record's own fields (a forged or edited record).
 */
export function validateCandidateVerification(value: unknown): CandidateVerification {
  const record = requiredObject(value, "CandidateVerification");
  for (const key of Object.keys(record)) {
    if (!RECORD_KEYS.has(key)) throw new Error(`CandidateVerification has unknown field ${key}`);
  }
  if (record.kind !== candidateVerificationKind) throw new Error(`CandidateVerification kind must be ${candidateVerificationKind}`);
  if (record.schemaVersion !== 1) throw new Error("CandidateVerification schemaVersion must be 1");
  const evidenceIds = record.evidenceIds;
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) throw new Error("CandidateVerification evidenceIds must be a non-empty array");
  evidenceIds.forEach((id, index) => {
    nonEmpty(id, `evidenceIds[${index}]`);
    if (index > 0 && !((evidenceIds[index - 1] as string) < (id as string))) throw new Error("CandidateVerification evidenceIds must be sorted and unique");
  });
  const verifier = requiredObject(record.verifier, "verifier");
  if (Object.keys(verifier).some((key) => key !== "id" && key !== "version")) throw new Error("CandidateVerification verifier has an unknown field");
  const verdict = normalizeVerdict({
    result: record.result,
    ...("abstainReason" in record ? { abstainReason: record.abstainReason } : {}),
    ...("score" in record ? { score: record.score } : {}),
  });
  const payload: Omit<CandidateVerification, "id"> = {
    kind: candidateVerificationKind,
    schemaVersion: 1,
    candidateId: nonEmpty(record.candidateId, "candidateId"),
    evidenceIds: evidenceIds as string[],
    valueDigest: sha256Digest(record.valueDigest, "valueDigest"),
    inputDigest: sha256Digest(record.inputDigest, "inputDigest"),
    verifier: { id: nonEmpty(verifier.id, "verifier.id"), version: nonEmpty(verifier.version, "verifier.version") },
    method: oneOf(record.method, METHODS, "method"),
    result: verdict.result,
    ...(verdict.result === "abstain" ? { abstainReason: verdict.abstainReason } : {}),
    ...(verdict.result !== "abstain" && verdict.score !== undefined ? { score: verdict.score } : {}),
    createdAt: canonicalTimestamp(record.createdAt, "createdAt"),
  };
  const id = recordId(payload);
  if (record.id !== id) throw new Error("CandidateVerification id is not the digest of its fields");
  return deepFreeze({ id, ...structuredClone(payload) });
}

/** The candidate a fold reads records for: its id and its value as it is now. */
export interface CandidateVerificationSubject {
  candidateId: string;
  value: unknown;
  valueType?: string;
  /** When supplied, records must also match the full input digest. */
  evidence?: SupportEvidence[];
}

export type CandidateVerificationInapplicableReason = "other-candidate" | "value-changed" | "input-changed";

export interface FoldCandidateVerificationsResult {
  /** `not-evaluated` when no record applies to the subject's current value. Not a verdict. */
  status: "not-evaluated" | "evaluated";
  /** Valid records bound to this candidate and value, ordered by id. Abstentions included. */
  applicable: readonly CandidateVerification[];
  /** Valid records bound to another candidate, value, or input. */
  inapplicable: readonly { record: CandidateVerification; reason: CandidateVerificationInapplicableReason }[];
  /** Records that failed validation, by input position. Never read further. */
  rejected: readonly { index: number; reason: string }[];
}

/**
 * Sorts records for one candidate into those that apply to its current value,
 * those bound to something else, and those that failed validation. Never
 * selects a winner among applicable records and never derives a trust state.
 */
export function foldCandidateVerifications(
  subject: CandidateVerificationSubject,
  records: readonly unknown[],
): FoldCandidateVerificationsResult {
  const candidateId = nonEmpty(subject.candidateId, "candidateId");
  const currentValueDigest = valueDigest(subject.value);
  const currentInputDigest = subject.evidence === undefined
    ? undefined
    : supportVerificationInputDigest({ candidateId, value: subject.value, ...(subject.valueType !== undefined ? { valueType: subject.valueType } : {}), evidence: subject.evidence });
  const applicable = new Map<string, CandidateVerification>();
  const inapplicable = new Map<string, { record: CandidateVerification; reason: CandidateVerificationInapplicableReason }>();
  const rejected: { index: number; reason: string }[] = [];
  records.forEach((raw, index) => {
    let record: CandidateVerification;
    try {
      record = validateCandidateVerification(raw);
    } catch (error) {
      rejected.push(Object.freeze({ index, reason: error instanceof Error ? error.message : String(error) }));
      return;
    }
    const reason: CandidateVerificationInapplicableReason | undefined = record.candidateId !== candidateId
      ? "other-candidate"
      : record.valueDigest !== currentValueDigest
        ? "value-changed"
        : currentInputDigest !== undefined && record.inputDigest !== currentInputDigest
          ? "input-changed"
          : undefined;
    if (reason) inapplicable.set(record.id, Object.freeze({ record, reason }));
    else applicable.set(record.id, record);
  });
  const byId = <T>(entries: Map<string, T>) => [...entries.keys()].sort().map((id) => entries.get(id)!);
  const applicableRecords = byId(applicable);
  return Object.freeze({
    status: applicableRecords.length === 0 ? "not-evaluated" as const : "evaluated" as const,
    applicable: Object.freeze(applicableRecords),
    inapplicable: Object.freeze(byId(inapplicable)),
    rejected: Object.freeze(rejected),
  });
}

function recordId(payload: Omit<CandidateVerification, "id">): string {
  return digest("survey.candidate-verification/v1", payload);
}

function normalizeInput(input: SupportVerificationInput): SupportVerificationInput {
  const value = requiredObject(input, "SupportVerificationInput");
  if (!("value" in value)) throw new Error("SupportVerificationInput value is required");
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) throw new Error("SupportVerificationInput evidence must be a non-empty array");
  const evidence = value.evidence.map((entry, index) => {
    const item = requiredObject(entry, `evidence[${index}]`);
    return {
      id: nonEmpty(item.id, `evidence[${index}].id`),
      excerpt: text(item.excerpt, `evidence[${index}].excerpt`),
      locator: nonEmpty(item.locator, `evidence[${index}].locator`),
      ...(item.context !== undefined ? { context: text(item.context, `evidence[${index}].context`) } : {}),
    };
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  evidence.forEach((entry, index) => {
    if (index > 0 && evidence[index - 1]!.id === entry.id) throw new Error(`SupportVerificationInput evidence id ${entry.id} is repeated`);
  });
  return {
    candidateId: nonEmpty(value.candidateId, "candidateId"),
    value: value.value,
    ...(value.valueType !== undefined ? { valueType: nonEmpty(value.valueType, "valueType") } : {}),
    evidence,
  };
}

function normalizeVerifier(value: { id: unknown; version: unknown; method: unknown }): { id: string; version: string; method: SupportVerificationMethod } {
  const verifier = requiredObject(value, "verifier");
  return {
    id: nonEmpty(verifier.id, "verifier.id"),
    version: nonEmpty(verifier.version, "verifier.version"),
    method: oneOf(verifier.method, METHODS, "verifier.method"),
  };
}

function normalizeVerdict(value: unknown): SupportVerdict {
  const verdict = requiredObject(value, "verdict");
  for (const key of Object.keys(verdict)) {
    if (key !== "result" && key !== "abstainReason" && key !== "score") throw new Error(`verdict has unknown field ${key}`);
  }
  const result = oneOf(verdict.result, RESULTS, "verdict.result");
  if (result === "abstain") {
    if ("score" in verdict) throw new Error("an abstaining verdict carries no score");
    return { result, abstainReason: oneOf(verdict.abstainReason, ABSTAIN_REASONS, "verdict.abstainReason") };
  }
  if ("abstainReason" in verdict) throw new Error("abstainReason is only allowed when result is abstain");
  if (!("score" in verdict)) return { result };
  const score = verdict.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) throw new Error("verdict.score must be a number from 0 to 1");
  return { result, score };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function sha256Digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a sha256:<64 hex> digest`);
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = nonEmpty(value, label);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) throw new Error(`${label} must be a canonical ISO timestamp`);
  return timestamp;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
