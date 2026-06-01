# Survey

Survey is the producer-side context for turning observations from source material into Surface-ready TrustInput. It standardizes the language between upstream producer workflows and downstream trust reporting without owning acquisition, review policy, or vertical-specific meaning.

Use Surface language when Survey is preparing a one-to-one Surface concept. Use Survey-specific language only for producer-side concepts before the Surface boundary.

## Language

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

**Selected Candidate**:
The candidate the **Producer** currently prefers within a **Candidate Set**. Selection is not the same as verification.
_Avoid_: Verified candidate, winner

**Review Outcome**:
The producer's recorded review decision for a **Candidate Set** or a specific **Candidate**. A **Review Outcome** can verify, assume, reject, or leave a candidate proposed, but it belongs to the producer workflow rather than Survey policy.
_Avoid_: Review, approval when the status may not be verified, policy decision

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
