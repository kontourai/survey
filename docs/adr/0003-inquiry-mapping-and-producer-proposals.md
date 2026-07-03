> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# Inquiry Mapping and Producer Proposals

> **Reconstructed after the fact** from citation sites across `src/` and
> `docs/record-contracts.md` — 2026-07-01. No original ADR 0003 document existed
> prior to this reconstruction; this file documents the rules the code already
> enforces and cites, not a new decision. Where the citing code was ambiguous
> (see the Reconciliation note), this reconstruction preserves one canonical
> numbered list rather than asserting original intent.

## §1 Context

Survey's source → extraction → candidate → review → claim chain was built for
web-crawl and document producers. Two later producer profiles needed to feed the
same chain from inputs that are not web pages: a natural-language *inquiry/question*
stream, and an *agent's own utterances*. Both needed to reach verified claims
through exactly the same review machinery, without a shortcut that lets a
model-backed adapter decide a question or a claim on its own.

Cited by: `src/inquiry-mapping.ts:1-18`, `src/agent-utterance.ts:1-18`.

## §2 Decision

Survey supports **producer-profile modules**: pluggable adapters that turn a
non-web-crawl source into Survey candidates, following the same
source → extraction → candidate → review → claim chain as any other producer. A
producer profile contributes proposers/extractors and a durable reviewed
artifact; it never contributes a way to skip review.

## §3 Scope

This ADR governs the pluggable interfaces of the producer-profile modules —
`MappingProposer`, `UtteranceClaimExtractor`, and any model-backed adapter such
as the Anthropic implementations — and the durable `InquiryMapping` artifact. It
does not change the Surface boundary, the review workbench, or the record
contracts themselves; those are documented in `docs/record-contracts.md`.

## §4 Proposals-only rule (hard constraint)

Nothing in a producer-profile module may silently decide a question or claim.
Every pluggable interface (`MappingProposer`, `UtteranceClaimExtractor`, and any
model-backed adapter such as the Anthropic implementations) is a PROPOSER only —
its output (`MappingProposal`, `ExtractedStatement`) is a reviewable record with
full provenance (excerpt, span, extractor name, confidence) that flows through
Survey's existing candidate → review machinery before it counts. Exact
canonical-form text matching is the only thing that may resolve without review.

Cited by: `src/inquiry-mapping.ts:2,13,60,100`, `src/schema-mapping.ts:7`,
`src/anthropic.ts:4,133,185,301,420`, `src/agent-utterance.ts:13-17,127`,
`docs/record-contracts.md:658`.

## §5 Inquiry mapping (implementation step)

`InquiryMapping` is the durable reviewed artifact of the inquiry producer
profile: it records that a natural-language question resolves to a canonical
claim target or derivation rule, after that mapping has been reviewed.
`resolveQuestion`/`lookupMapping` are the integration entry points a consumer
calls to check whether a reviewed mapping already covers a question.

Cited by: `src/inquiry-mapping.ts:1-18` ("ADR 0003 step 5").

## §6 Memoize the mapping, never the answer

An `InquiryMapping` records that a natural-language question maps to a canonical
claim target or derivation rule — that mapping is memoized. The *answer* is never
cached: every resolution recomputes live from the current `TrustBundle`/claim
status at resolution time, so a stale cached answer can never be served even
though the question → target mapping is reused.

The agent-utterance module (step 6 in the rollout) is the second producer profile
built under these same rules.

Cited by: `src/inquiry-mapping.ts:60-64`, `docs/record-contracts.md:653-654`,
`src/agent-utterance.ts:1-2`.

## Reconciliation note

The citing code uses two numbering schemes against this same document: a
**"step N"** rollout sequence (inquiry-mapping is "step 5", agent-utterance is
"step 6") and a **"§N"** rule-section reference (the proposals-only rule is "§4",
the memoize-the-mapping rule is "§6"). This is a known ambiguity surfaced during
reconstruction, not asserted original intent. This document preserves one
canonical numbered list — §1–§6 above — so future citations resolve
unambiguously, and calls out the rollout "step 5"/"step 6" labels inline in §5
and §6 so the existing module doc-comments still line up.
