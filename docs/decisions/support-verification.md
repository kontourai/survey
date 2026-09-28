---
status: current
subject: Support Verification
decided: 2026-09-28
evidence:
  - kind: issue
    ref: "https://github.com/kontourai/survey/issues/292"
  - kind: doc
    ref: docs/record-contracts.md
  - kind: doc
    ref: src/candidate-verification.ts
---
# Support Verification

## Decision

Survey owns a `SupportVerifier` port and an immutable `CandidateVerification`
record. The record says what an identified verifier said about one candidate's
value and evidence. It is not a trust decision. Nothing in Survey routes,
auto-accepts, calibrates, or projects on it, so a record can never upgrade a
candidate. Survey ships no verifier implementations. Deterministic producer-side
annotations stay with the producer, and model adapters live in separate
packages, as the producer-profile decision already requires.

A verifier's failure is recorded as an abstention with a reason (`error`,
`empty`, `malformed`, `timeout`), never as a pass or a fail. `score` is optional,
never defaulted, uncalibrated unless a calibration record says otherwise, and
never feeds `confidence` or `conclusionConfidence`.

## Choices the issue left open

- **Where records ride.** On `ReviewCandidate.verifications`, the candidate the
  decision surfaces read. `SurveyInput` candidates do not carry them yet,
  because the only reader there would be the Surface projection, which is a
  separate change.
- **Inputs digest.** Besides `valueDigest` (the Surface-compatible value
  binding), each record carries `inputDigest` over everything the verifier was
  given. The fold checks it only when the caller supplies the evidence. The
  decision surfaces do not, so on those surfaces a record binds by candidate
  and value.
- **Verifier method on the port.** `method` is declared by the verifier, not
  per call, so one verifier identity cannot report mixed methods.
- **Score range.** A score must be a finite number from 0 to 1. Anything else is
  a malformed verdict.
- **Empty evidence.** An input with no evidence is a caller error and throws. It
  is not recorded as an abstention.
- **Status vocabulary.** The fold's `status` is `not-evaluated` or `evaluated`.
  `evaluated` means only that at least one valid record applies to the current
  value, and it includes abstentions. There is no aggregate verdict.
- **What reviewers see.** Verifier, version, method and result (or abstention
  reason) for each applicable record, plus counts of records that do not apply
  and records that failed validation. The score is not shown, because it is
  uncalibrated.
