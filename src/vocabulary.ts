import type { ConfidenceBasis, ImpactLevel, TrustStatus } from "@kontourai/surface";

/**
 * Builds a stable, url-safe identifier from ordered parts. Each part is
 * lowercased, non-alphanumeric runs collapse to a single hyphen, leading and
 * trailing hyphens are trimmed, and parts join with a dot.
 *
 * `stableId(["Public Record", "entity-123", "current"])` → `"public-record.entity-123.current"`.
 *
 * Producers use this to derive deterministic candidate, candidate-set, and claim
 * identifiers from domain values without inventing their own slug helper.
 */
export function stableId(parts: ReadonlyArray<string | number>): string {
  return parts
    .map((part) =>
      String(part)
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase(),
    )
    .join(".");
}

/**
 * A product's Survey/Surface vocabulary: the subject type and facet it
 * projects onto, its claim-type names, and its decision-effect names. Generic
 * over the caller's claim-type and decision-effect key maps so the concrete
 * string literals stay visible to callers.
 *
 * `facet` mirrors Surface's `Claim.facet` (Hachure schema 5 facet rename:
 * `Claim.surface` -> `Claim.facet`, surface@2.0.0). The now-deprecated
 * `surface` property is kept, mirroring `facet`, for one release so existing
 * readers of `.surface` do not break; read `.facet` going forward.
 */
export interface ProductVocabularyDefinition<
  TClaimTypes extends Readonly<Record<string, string>>,
  TDecisionEffects extends Readonly<Record<string, string>>,
> {
  readonly subjectType: string;
  readonly facet: string;
  /**
   * @deprecated Renamed to {@link ProductVocabularyDefinition.facet} (Hachure
   * schema 5 facet rename: `Claim.surface` -> `Claim.facet`). Mirrors `facet`
   * for one release; read `.facet` going forward.
   */
  readonly surface: string;
  readonly claimTypes: TClaimTypes;
  readonly decisionEffects: TDecisionEffects;
}

/**
 * Input accepted by {@link defineProductVocabulary}: `facet` is the
 * canonical name; the deprecated `surface` name is still accepted for one
 * release as a read-compat alias (Hachure schema 5 facet rename). Exactly
 * one of `facet` / `surface` is required — the union below is what makes
 * "at least one of these two" a compile-time requirement rather than a
 * runtime-only check.
 */
export type ProductVocabularyInput<
  TClaimTypes extends Readonly<Record<string, string>>,
  TDecisionEffects extends Readonly<Record<string, string>>,
> = {
  readonly subjectType: string;
  readonly claimTypes: TClaimTypes;
  readonly decisionEffects: TDecisionEffects;
} & (
  | { readonly facet: string; readonly surface?: string }
  | {
      readonly facet?: undefined;
      /**
       * @deprecated Renamed to `facet` (Hachure schema 5 facet rename:
       * `Claim.surface` -> `Claim.facet`). Accepted for one release; using it
       * without also passing `facet` emits a single deprecation warning per
       * process. Prefer `facet`.
       */
      readonly surface: string;
    }
);

let warnedLegacyVocabularySurfaceOnce = false;

function warnLegacyVocabularySurfaceOnce(): void {
  if (warnedLegacyVocabularySurfaceOnce) return;
  warnedLegacyVocabularySurfaceOnce = true;
  console.warn(
    "[@kontourai/survey] deprecated: defineProductVocabulary's \"surface\" option is renamed to " +
      "\"facet\" (Hachure schema 5 facet rename: Claim.surface -> Claim.facet, surface@2.0.0). " +
      "Pass \"facet\" instead of \"surface\"; \"surface\" is accepted for one release as a read-compat alias.",
  );
}

function resolveFacet(definition: { readonly facet?: string; readonly surface?: string }): string {
  if (definition.facet !== undefined) return definition.facet;
  if (definition.surface !== undefined) {
    warnLegacyVocabularySurfaceOnce();
    return definition.surface;
  }
  throw new Error('defineProductVocabulary requires "facet" (or deprecated "surface")');
}

/**
 * Defines a product vocabulary as a deep-frozen, discoverable value that a
 * `currentProposedReviewItem` caller can pass instead of loose top-level
 * constants. Returns the same shape it received (plus the mirrored
 * deprecated `surface` alias — see {@link ProductVocabularyDefinition}),
 * frozen so callers cannot mutate a shared vocabulary at runtime.
 *
 * Accepts either the canonical `facet` option or the deprecated `surface`
 * option (not both required — `facet` wins when both are supplied, and
 * using `surface` alone emits a single deprecation warning per process; see
 * {@link ProductVocabularyInput}).
 *
 * The type parameters carry the `const` modifier, so `claimTypes` and
 * `decisionEffects` string properties keep their literal types whether or
 * not the caller appends `as const` to the argument — do not re-add an
 * `as const` requirement to this helper's documented usage; it is not
 * needed here (requires TypeScript 5.0+; unlike a plain object literal
 * passed to a non-`const` generic elsewhere), and callers who already write
 * `as const` continue to compile identically. Note: the `const` type-
 * parameter syntax itself requires a TypeScript 5.0+ compiler to parse this
 * function's declaration at all (see `package.json`'s
 * `peerDependencies.typescript` and `docs/upgrade-guide.md`); this is a
 * types-only floor and does not affect JavaScript consumers.
 */
export function defineProductVocabulary<
  const TClaimTypes extends Readonly<Record<string, string>>,
  const TDecisionEffects extends Readonly<Record<string, string>>,
>(
  definition: ProductVocabularyInput<TClaimTypes, TDecisionEffects>,
): ProductVocabularyDefinition<TClaimTypes, TDecisionEffects> {
  const facet = resolveFacet(definition);
  return deepFreeze({
    subjectType: definition.subjectType,
    facet,
    surface: facet,
    claimTypes: { ...definition.claimTypes },
    decisionEffects: { ...definition.decisionEffects },
  });
}

export interface ConfidenceBasisForReviewInput {
  readonly status: TrustStatus;
  readonly impactLevel: ImpactLevel;
  readonly extractionConfidence?: number;
  readonly sourceQuality?: ConfidenceBasis["sourceQuality"];
  readonly reviewerAuthority?: ConfidenceBasis["reviewerAuthority"];
  readonly evidenceStrength?: ConfidenceBasis["evidenceStrength"];
}

/**
 * Builds a {@link ConfidenceBasis} from a reviewed status and impact level.
 *
 * The two known real-world consumers hand-roll *different* five-field
 * mappings, not one shared algorithm: one derives `sourceQuality` and
 * `evidenceStrength` from whether any extraction/review support exists at
 * all, and never returns `"strong"` for either field even when `status` is
 * `"verified"` with no supporting evidence; the other derives `sourceQuality`
 * from the extracted document's source type (independent of `status`) and
 * `evidenceStrength` from `status` alone, never returning `"weak"` or
 * `"none"`. There is no single formula that reproduces both, so this helper
 * does not attempt to guess one.
 *
 * Defaults are therefore conservative-by-default: `sourceQuality` defaults to
 * `"unknown"` and `evidenceStrength` defaults to `"none"` — the weakest
 * possible values — unless the caller supplies an explicit value. The only
 * field this helper derives from `status` without an explicit override is
 * `reviewerAuthority` (`"operator"` when `status === "verified"`, otherwise
 * `"none"`), because that is the one mapping both known real algorithms
 * agree on for every non-verified status, and it is exactly what the more
 * conservative of the two returns for the verified case too. `impactLevel`
 * is always the caller-supplied value (never defaulted). `extractionConfidence`
 * is copied through and included on the result only when provided; its mere
 * presence no longer implies a stronger `sourceQuality`/`evidenceStrength` by
 * default — callers who know that an extraction or review should count as
 * support must say so explicitly.
 *
 * Producers with domain knowledge about their own source quality or evidence
 * strength should pass `sourceQuality`/`evidenceStrength` explicitly instead
 * of relying on the bare defaults — for example, a source-type-driven
 * mapping (strong for corrected/high-confidence documents, moderate for
 * medium-confidence documents, weak otherwise) the way one known consumer
 * derives `sourceQuality` from its extracted record's source type. This
 * function is a conservative, independently-designed baseline, not a
 * behavioral match for either known consumer's algorithm; verify against
 * your own data before treating it as a drop-in replacement for hand-rolled
 * mapping logic.
 */
export function confidenceBasisForReview(
  input: ConfidenceBasisForReviewInput,
): ConfidenceBasis {
  const verified = input.status === "verified";

  const basis: ConfidenceBasis = {
    sourceQuality: input.sourceQuality ?? "unknown",
    reviewerAuthority: input.reviewerAuthority ?? (verified ? "operator" : "none"),
    evidenceStrength: input.evidenceStrength ?? "none",
    impactLevel: input.impactLevel,
  };

  if (input.extractionConfidence !== undefined) {
    basis.extractionConfidence = input.extractionConfidence;
  }

  return basis;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
