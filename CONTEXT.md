# Survey

Survey is the producer-side context for turning observations from source material into Surface-ready TrustInput. It standardizes the language between upstream producer workflows and downstream trust reporting without owning acquisition, review policy, or vertical-specific meaning.

Use Surface language when Survey is preparing a one-to-one Surface concept. Use Survey-specific language only for producer-side concepts before the Surface boundary.

## Language

**Kontour Resource Shape**:
The shared convention for new portable Kontour records: `apiVersion`, `kind`, `metadata`, `spec`, optional `status`, and optional `proof`. Canonical doc: https://github.com/kontourai/kontourai.io/blob/main/docs/kontour-resource-shape.md. Survey-specific use: durable review/provenance records should use the shape when they cross product boundaries or need to be inspected by Surface, agents, or external systems. Review records should be immutable once emitted; if a review changes, emit a new record. Survey `proof` anchors the canonical review trail and projection, not the real-world truth of the source.
_Avoid_: Duplicating Surface integrity semantics, hiding review outcomes in metadata, treating a Survey proof as source veracity

**Producer**:
The upstream system or operator workflow that gathers observations and packages them into Survey records. A **Producer** owns acquisition, parsing, ranking, review UX, materiality, and domain policy.
_Avoid_: Client, crawler, ingestion platform

**Survey**:
The contract boundary that carries producer evidence through a source -> extraction -> candidate -> review -> claim chain. **Survey** does not decide whether a real-world value is true; it preserves the producer's evidence and review posture for Surface.
_Avoid_: Ingestion platform, crawler, reviewer

**Surface**:
The downstream trust reporting context that receives Survey-ready trust records and produces trust reports, derived views, console projections, and transparency outputs.
_Avoid_: Survey, producer

**Observation**:
A producer-observed unit of source material and extracted meaning that can be packaged into one claim path. An **Observation** normally includes one **Raw Source**, one **Extraction**, one **Candidate Set**, optional **Review Outcome**, and one **Claim**.
_Avoid_: Event, scrape, import

**Source-of-Authority Observation**:
An **Observation** whose **Raw Source** is treated by the **Producer** as authoritative for the extracted target, such as an official rule publication, registration platform page, policy document, contract record, or system-of-record response. Survey validates the record discipline around this posture — source identity, source reference, locator, declared source-authority class, declared scope, effective period when applicable, and review posture before verified or assumed projection. A verified or assumed **Source-of-Authority Observation** should require a **Review Outcome** with reviewer and reviewed time plus the source-authority posture fields; otherwise it is a normal **Observation** with source metadata. Survey does not independently validate that the source is legally, organizationally, or contextually authoritative. Source-authority metadata should project through Surface **Evidence** metadata in v0 because it describes the evidence source. The term describes source posture, not reviewer authority. Surface **Authority Trace** remains the downstream concept for why an actor, credential, role, organization, policy, or system had authority over a claim or evidence record. Use `sourceOfAuthorityObservation` as the working helper/API name when this pattern becomes executable work.
_Avoid_: Authority-backed observation, treating source authority as reviewer authority, mapping source authority to Surface Authority Trace, implying Survey independently validates the source's legal or organizational authority, using source authority as a shortcut for claim correctness

**Raw Source**:
The source material observed by a **Producer**, such as an uploaded document, web page, API record, or manual entry. A **Raw Source** is evidence-bearing material, not the producer identity or the downstream claim.
_Avoid_: Source, input, document when the material may not be a document

**Source Reference**:
A stable reference to where a **Raw Source** came from, such as a URL or document URI. A **Source Reference** identifies the material; it does not by itself prove the extracted value.
_Avoid_: Locator, source

**Source Locator**:
A precise pointer inside a **Raw Source** where an **Extraction** came from, such as a PDF page region, HTML field, text span, or structured field path.
_Avoid_: Source reference, citation

**Extraction**:
A value pulled from a **Raw Source** for a named target by a producer-controlled extractor. An **Extraction** is evidence of what the source material appeared to say, not a claim that the value is final or true.
_Avoid_: Claim, verified value, parse result

**Extraction Target**:
The producer or extractor's name for the thing being pulled from a **Raw Source**. An **Extraction Target** often matches a claim's **Field or Behavior**, but it may differ when the extracted source field is only a candidate or source-specific representation.
_Avoid_: Field or Behavior when referring to source-side extraction

**Candidate**:
A possible value for a target, backed by an **Extraction**, that may be selected, reviewed, rejected, or superseded. A **Candidate** is one option inside a **Candidate Set**.
_Avoid_: Claim, answer, final value

**Candidate Set**:
The producer's grouping of candidate values for the same target. A **Candidate Set** has one or more **Candidates** and may identify a selected candidate while still needing review.
_Avoid_: Choice list, ranking, review queue

**Current/Proposed Candidate Set**:
A **Candidate Set** with exactly two producer roles for the same target: the current candidate the producer would keep absent a change, and the proposed candidate introduced by new source material, extraction, or review work. The pattern is similar to a code diff, but Survey language should keep the focus on candidate roles and review outcome rather than patches or approvals.
_Avoid_: Diff, approved field, rejected field, current-vs-proposed field

**Reviewed Current/Proposed Resolution**:
A reviewed producer decision over a **Current/Proposed Candidate Set** that selects either the current candidate or the proposed candidate and records the durable **Review Outcome**. Use this term for the action-oriented helper shape; it is a specialization of reviewed candidate resolution, not a separate review policy.
_Avoid_: Current proposed helper, approval resolution, diff application

**Selected Candidate**:
The candidate the **Producer** currently prefers within a **Candidate Set**. Selection is not the same as verification.
_Avoid_: Verified candidate, winner

**Review Outcome**:
The producer's recorded review decision for a **Candidate Set** or a specific **Candidate**. A **Review Outcome** can verify, assume, reject, or leave a candidate proposed, but it belongs to the producer workflow rather than Survey policy.
_Avoid_: Review, approval when the status may not be verified, policy decision

**Comfort Zone Flag**:
An optional `withinComfortZone: false` marker on a **Review Outcome**, paired with an optional `comfortZoneNote`, indicating the reviewer recorded a posture outside their domain expertise or is flagging that the conclusion requires a different authority to confirm. Without this flag, producers have no way to distinguish "I reviewed this confidently" from "I recorded a posture but a specialist should confirm" — both look like a normal **Review Outcome**. Survey carries the flag forward to the Surface verification event so the reviewer chain sees the signal rather than having to read into the rationale body.
_Avoid_: Encoding uncertainty only in rationale text, using a low-confidence extraction as a proxy for reviewer uncertainty, conflating extraction confidence with reviewer comfort zone

**Escalation Record**:
A durable record of a challenge raised against a target that was not fully addressed by the originating producer pass. An **Escalation Record** captures what a second-pass producer — whether an automated adversary, a rules engine, or a human reviewer — flagged as a gap: a missing consideration, a misframed question, a conclusion that would not survive challenge, or a citation mismatch. The problem it solves: without a first-class slot for "this target was not addressed," producers have no option except to paper over genuine uncertainty with a confident-looking claim or to silently omit the target entirely. An **Escalation Record** makes the gap part of the provenance trail. Unresolved escalations attached to a claim project to Surface as additional **Disputed** verification events so the reviewer sees the challenge alongside the claim rather than discovering it later. Resolved escalations (with `resolvedBy` set to the observation that closed them) are carried in the record without projecting an event.
_Avoid_: Open question as a comment in rationale, treating raised challenges as errors rather than as legitimate posture, conflating escalation with a failed extraction

**Escalation Dimension**:
The category of a challenge raised in an **Escalation Record**: `framing` (the wrong question was framed or the wrong unit of analysis was chosen), `completeness` (a required standard, alternative, or evidence was not addressed), `conclusion` (the reasoning would not survive a competent reviewer's challenge), or `citation` (cited sources do not support the claims attached to them). The dimension guides the reviewer toward the kind of response the escalation requires — a framing challenge asks the producer to re-examine the question, while a completeness challenge asks them to extend the record.
_Avoid_: Generic "issue type", collapsing all dimensions into a single flag, using dimension as a severity score

**Adversarial Pass**:
A second producer run that challenges a first-pass producer by adding conflicting candidates, raising escalation records, or both. An **Adversarial Pass** is a producer convention, not a Survey concept: Survey sees two producers disagreeing on the same target, which is what **Candidate Conflict** and **Escalation Record** are designed to carry. The adversary is identified by a distinct `extractor` id; Survey does not need to know it is an LLM, a rules engine, or a human. Use **Candidate Conflict** when the adversary disagrees on the extracted value. Use **Escalation Record** when the adversary identifies a target that was not addressed at all.
_Avoid_: Wiring LLM-specific logic into Survey, treating the adversary as a special Survey actor, conflating the adversary with the human reviewer

**Claim**:
A Surface claim prepared from Survey records. Survey uses Surface's **Claim** semantics; Survey-specific language should only explain how producer-side **Raw Sources**, **Extractions**, **Candidates**, and **Review Outcomes** project into claims.
_Avoid_: Extraction, candidate, fact

**Field or Behavior**:
The Surface-facing name for what a **Claim** is about on its subject. **Field or Behavior** may match the **Extraction Target**, but it should use the claim vocabulary a downstream Surface viewer or agent needs.
_Avoid_: Extraction Target when referring to claim meaning

**Claim Dependency**:
A relationship where one **Claim** depends on one or more supporting **Claims**, usually because its value was computed from those inputs. Surface owns dependency semantics such as weakest-input status ceilings, recompute pressure, cycle detection, and transparency gaps.
_Avoid_: Derived claim as a separate claim kind, evidence, rollup

**TrustInput**:
The Surface schema that Survey produces from producer-side observations. Use **TrustInput** or "Surface-ready TrustInput" for the handoff into Surface instead of inventing a Survey-branded synonym.
_Avoid_: Trust Record, Survey record, report

**Producer Discipline**:
Survey's narrower application of Surface **Producer Discipline** to the source/extraction/review boundary. In Survey, verified or assumed claims require review authority, reviewed timing, and source locators for non-manual sources so unreviewed extractions are not laundered into trusted claims.
_Avoid_: Survey policy, validation only, Surface-owned truth

## Status Language

**Surface Status**:
Surface owns core claim status semantics, including proposed, assumed, verified, stale, disputed, superseded, and rejected. Survey may carry or project these statuses, but it should not redefine them.
_Avoid_: Survey-specific claim status semantics, trust score

**Review Status**:
The Surface status recorded by a **Review Outcome** for a candidate or candidate set. In Survey, verified and assumed review statuses require producer review authority and reviewed timing.
_Avoid_: Candidate Set Status, workflow status

**Candidate Conflict**:
A candidate-set status meaning the producer sees competing candidate values for the same target before a claim posture can be resolved. A **Candidate Conflict** is narrower than Surface's broader **Conflict** concept and may project into a **Disputed** claim status.
_Avoid_: Conflict without qualification, dispute when referring to the candidate set before projection to Surface

**Needs Review**:
A candidate-set status meaning candidates exist but the producer has not completed the review workflow needed for verified or assumed status.
_Avoid_: Unresolved, pending claim

**Escalated**:
A candidate-set status meaning the producer was unable to produce a reliable candidate for the target and is requesting specialist framing before any value can be proposed. **Escalated** is distinct from **Needs Review** (candidates exist but need selection) and from **Candidate Conflict** (candidates exist and disagree); it signals that the target itself is uncertain before a candidate could be formed. Projects to a **Disputed** claim in Surface with a `candidate-escalation` verification event. Use **Escalation Record** instead when the gap is identified by a second-pass producer rather than the originating producer.
_Avoid_: Treating escalated as a higher-severity version of needs-review, using escalated when candidates do exist

**Resolved**:
A candidate-set status meaning the producer has selected a candidate for the target. **Resolved** is not the same as **Verified**; the selected candidate may still project as proposed without a **Review Outcome**.
_Avoid_: Verified, completed

## Flagged Ambiguities

**Source**:
Plain "source" is ambiguous in this repo. Use **Producer** for the upstream system, **Raw Source** for observed material, **Source Reference** for where the material came from, and **Source Locator** for the position inside the material.

**Review**:
"Review" can mean a user interface, a producer workflow, or the recorded **Review Outcome**. In Survey domain language, use **Review Outcome** only for the durable decision Survey carries; use "producer review workflow" for the external workflow owned by the **Producer**.

**Resolved**:
In a **Candidate Set**, **Resolved** means the producer selected a candidate; it does not imply the resulting **Claim** is **Verified**.

**Derived Claim**:
Do not use this as a separate Survey concept. Use **Claim** for the assertion and **Claim Dependency** for the relationship to supporting claims.

**Conflict**:
Surface uses **Conflict** broadly for visible disagreement between claims, evidence, or policies. Survey should use **Candidate Conflict** when the disagreement is specifically between candidate values before projection.

**Field Observation and Repeated Observation**:
These are helper shapes for authoring **Observations**, not separate domain concepts. Use **Observation** for the domain term and describe scalar or repeated representation only when the value shape matters.

**Target**:
"Target" is ambiguous unless qualified. Use **Extraction Target** for source-side extraction and **Field or Behavior** for claim-side meaning.

**Escalated vs. Needs Review vs. Candidate Conflict**:
These three candidate-set statuses address different problems and should not be used interchangeably. **Needs Review** means candidates exist and are waiting for a human to select one. **Candidate Conflict** means candidates exist and a second source or pass disagrees on the value — the producer has a selection problem. **Escalated** means the producing pass could not form a reliable candidate at all and needs specialist framing before the question can even be answered — there is no selection problem yet because there is nothing reliable to select from. An **Escalation Record** is the second-pass analog to **Escalated**: use it when a second producer, not the originating one, identifies the gap.

**Diff**:
Use only as an analogy for explaining **Current/Proposed Candidate Set** behavior. In Survey domain language, the durable concepts are **Candidate**, **Candidate Set**, **Selected Candidate**, and **Review Outcome**.

**Survey-Branded Language**:
Use Survey-specific terms only when the concept is unique to the producer-side source -> extraction -> candidate -> review chain. When a concept maps one-to-one to Surface, reuse the Surface term.

**Subject and Claim Type**:
These are one-to-one Surface concepts. Do not redefine them in Survey unless Survey adds producer-side nuance; otherwise use Surface's definitions directly.

**Evidence**:
This is a Surface concept. Survey should describe producer-side evidence ingredients as **Raw Source**, **Source Reference**, **Source Locator**, and **Extraction**; projection turns those into Surface **Evidence**.

## Example Dialogue

Developer: "The producer observed a web page and extracted `availabilityStatus` from an HTML field."

Domain expert: "So the web page is the Raw Source, the URL is the Source Reference, and the HTML field is the Source Locator."

Developer: "The extraction produced `WAITLIST`, but the operator has not reviewed it."

Domain expert: "That should become a Candidate in a Candidate Set with Needs Review status, then project to a Proposed Claim for Surface."

Developer: "A corrected document replaced an original amount field."

Domain expert: "Keep the original Claim as Superseded, create a Proposed Claim from the corrected Candidate, and connect any computed Claim to its input Claims through Claim Dependencies."

Developer: "An agent extracted a fair value figure but I'm not sure it considered all the required inputs. A second agent reviewed the first agent's output and flagged a gap."

Domain expert: "The second agent is an Adversarial Pass — it's a second Producer with a distinct extractor id. If it disagrees on the extracted value, add its Extraction as a second Candidate and set the Candidate Set to Conflict. If it identified a target the first pass didn't address at all, add an Escalation Record with dimension 'completeness' and attach it to the closest relevant Claim. Either way, Survey carries both producers' posture and the reviewer sees the disagreement in Surface rather than a silently confident claim."

Developer: "The reviewer approved the fair value figure but told me they're not a specialist in this area."

Domain expert: "Set withinComfortZone to false on the Review Outcome and add a comfortZoneNote. The Comfort Zone Flag travels with the Review Outcome to Surface so the next reviewer in the chain sees it on the verification event — they don't have to read the rationale to know this conclusion is waiting for specialist confirmation."
