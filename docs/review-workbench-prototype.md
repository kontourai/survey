# Review Workbench Prototype

The Survey review workbench prototype is a fixture-backed browser example for
inspecting one current/proposed `ReviewItem` and generating a
`ReviewDecision`-shaped payload in local memory.

The reusable implementation lives under `src/review-workbench/` and is exported
as `@kontourai/survey/review-workbench`. The standalone browser demo remains
under `examples/review-workbench/` as a thin bootstrap plus page-owned assets.
The workbench uses `publicDirectoryReviewItemFixture` from a browser-safe data
module that intentionally avoids package barrel imports and Node-only
dependencies, and `npm run check:review-workbench` fails if its `ReviewItem`
data drifts from the canonical `fixtures/public-directory-review-resource.ts`
fixture. The page renders the current and proposed candidates, source URL and
source ref, locator and excerpt, extraction confidence, candidate values,
reviewer note, decision controls, decision effect, a compact Surface preview,
and generated JSON payload.

## Running Locally

Build the package first so the browser can load the compiled example module:

```bash
npm run build
```

Then open `examples/review-workbench/index.html` in a browser from the repo
root. The first screen is the workbench itself.

The package check for prototype artifacts is:

```bash
npm run check:review-workbench
```

This is a static artifact and fixture-provenance guard. It confirms the built
example files exist, the browser-safe fixture matches the canonical ReviewItem
fixture, and Node-only imports are absent from the built example modules. It is
not browser/UI evidence for responsive behavior; browser evidence is collected
separately with Playwright.

`npm run verify` includes the content boundary check, typecheck, tests, and this
static review workbench guard.

The downstream-boundary dogfood proof in
[`downstream-adapter-dogfood-proof.md`](./downstream-adapter-dogfood-proof.md)
shows how a sanitized copied producer proposal can be adapted into the same
`ReviewItem` shape without adding product-specific workbench branches.

The queue fixture also includes a generic regulated rule-conflict `ReviewItem`
modeled after a downstream rules-management proof. It uses the same current /
proposed candidate roles, source locator, extraction confidence, producer
policy, and projection hints as the public-directory example. Survey code does
not know the downstream product name; the workbench only consumes the portable
resource shape.

## Decision Mapping

The prototype keeps reviewer note and selected decision state only in browser
memory. It does not persist or send payloads.

| Control | Candidate | `ReviewDecision.spec.status` | Outcome display |
| --- | --- | --- | --- |
| Accept proposed | proposed candidate | `verified` | proposed selected, current unselected |
| Keep current | current candidate | `verified` | current selected, proposed unselected |
| Reject proposed | proposed candidate | `rejected` | current selected, proposed unselected |

All generated payloads use the resource contract from
`src/review-resource.ts`: `apiVersion`, `kind: "ReviewDecision"`,
`metadata.name`, `spec.reviewItemName`, `spec.candidateId`, `spec.status`,
`spec.actor`, `spec.reviewedAt`, `spec.rationale`, `spec.projection`, and
`status.appliedToClaimIds`. The workbench also generates `ReviewSession` and
`ReviewSessionEvent` payloads for session audit and replay; those are covered
in [`consumer-integration-guide.md`](consumer-integration-guide.md).

## Surface Preview

After a reviewer chooses a decision, the workbench builds a browser-safe Surface
preview from the active `ReviewItem` plus the locally generated
`ReviewDecision`. Accepting the proposed candidate and keeping the current
candidate produce different previews because the selected canonical claim,
source evidence, candidate history, and review event are derived from the
decision candidate.

The preview is intentionally small and labelled. It shows:

- Selected canonical claim: candidate id, claim id, selected value, and review
  status.
- Unselected candidate history: the candidate values not selected by the
  decision.
- Source evidence: source URL/ref, excerpt, extraction details, and visible
  `sourceAuthority` metadata when the fixture provides it.
- Review event: actor, review time, status, rationale, and projected review
  outcome id.
- Integrity posture: candidate set, raw source, extraction, and checksum fields
  when present.
- Authority trace: an empty/not-provided neutral state unless portable
  authority trace data is actually present.

`sourceAuthority` is evidence metadata about the source, such as authority
class, declaring system, and scope. It is displayed in source evidence but is
not promoted into `authorityTrace`. An empty `authorityTrace` is not an error in
this prototype; it means the fixture does not include portable actor/system
authority trace data.

The preview records source and review posture for projection. It does not
validate leaf truth or assert that the selected value is true in the real world.
It is not a Surface Console replacement, trust graph view, persistence flow, or
production API.

## Non-Goals

This prototype does not add production persistence, authentication,
multi-product tenant administration, a queue/session workflow, a backend
builder abstraction, or live downstream integration. Producers still own
review UX, workflow state, assignment, policy, and adapters. Survey owns the
portable review resource shape and projection hints.
