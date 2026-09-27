import type { ReviewItem, ReviewValueDescriptor } from "../review-resource.js";

/**
 * Result of checking an inline edit (`data.workbenchEditedValue` on an
 * `accept-proposed` decision event) against the ReviewItem it edits.
 *
 * - `ok: true` — the edit is allowed; `value` is the value to store. When
 *   `convertedFromText` is true, the stored edit was descriptor-typed text
 *   written by an older workbench (for example `"42"` on a number field) and
 *   `value` is its typed form (`42`).
 * - `ok: false` — the edit must be refused: the item is not editable, or the
 *   value does not satisfy the item's `valueDescriptor`.
 */
export type EditedValueCheck =
  | { readonly ok: true; readonly value: unknown; readonly convertedFromText: boolean }
  | {
      readonly ok: false;
      readonly code: "edited-value-not-editable" | "edited-value-type-mismatch";
      readonly message: string;
    };

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True for a `YYYY-MM-DD` string naming a real calendar day. The Y/M/D must
 * round-trip through a UTC date, so an impossible day such as `2026-02-31`
 * (which `Date.parse` silently rolls over to March) is refused.
 */
export function isIsoCalendarDate(value: string): boolean {
  const match = isoDatePattern.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Plain decimal only: optional minus, no leading zeros, optional fraction and
// exponent. Refuses hex/binary/octal forms, "Infinity", "+1", ".5" and "007".
const plainDecimalPattern = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** A JSON number keeps at most 15 significant decimal digits exactly (IEEE 754 double). */
const maxSignificantDigits = 15;

/**
 * Parses number-field editor text, or returns `undefined` when it is not a
 * plain decimal or would not survive storage as a JSON number exactly: more
 * than 15 significant digits is refused rather than silently rounded, and a
 * value that overflows to Infinity is refused. `-0` is stored as `0` (JSON has
 * no negative zero).
 */
export function parsePlainDecimal(text: string): number | undefined {
  const match = plainDecimalPattern.exec(text);
  if (!match) return undefined;
  const digits = `${match[1]}${(match[2] ?? "").slice(1)}`.replace(/^0+/, "").replace(/0+$/, "");
  if (digits.length > maxSignificantDigits) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed === 0 ? 0 : parsed;
}

/**
 * Converts a reviewer's editor text to the JSON type the item's descriptor
 * declares, using the same parsing rules the workbench's `validateProposedValue`
 * checks. Returns `undefined` when the text does not parse for that type. With
 * no descriptor, or a type that has no single-line form (string, array, object),
 * the text is returned unchanged.
 */
export function editedValueFromEditorText(
  descriptor: ReviewValueDescriptor | undefined,
  text: string,
): unknown {
  if (!descriptor) return text;
  const trimmed = text.trim();
  switch (descriptor.type) {
    case "number":
      return parsePlainDecimal(trimmed);
    case "boolean":
      return trimmed === "true" ? true : trimmed === "false" ? false : undefined;
    case "date":
      return isIsoCalendarDate(trimmed) ? trimmed : undefined;
    case "enum": {
      const allowed = descriptor.enumValues ?? [];
      return allowed.length === 0 || allowed.includes(trimmed) ? trimmed : undefined;
    }
    default:
      return text;
  }
}

function valueMatchesDescriptor(descriptor: ReviewValueDescriptor, value: unknown): boolean {
  switch (descriptor.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && isIsoCalendarDate(value);
    case "enum": {
      if (typeof value !== "string") return false;
      const allowed = descriptor.enumValues ?? [];
      return allowed.length === 0 || allowed.includes(value);
    }
    case "string":
      return typeof value === "string";
    default:
      // array/object: the workbench has no typed editor for these, so Survey
      // declares no constraint on the edit's shape.
      return true;
  }
}

/**
 * Checks an inline edit carried by an `accept-proposed` decision against the
 * item's `editable` flag and `valueDescriptor`. This is the server-side
 * counterpart of the browser editor's validation (kontourai/survey#278): the
 * apply boundary must not trust an edit the workbench would never have let a
 * reviewer make.
 *
 * Legacy sessions: workbenches before this check stored every edit as the
 * editor's text, so a number or boolean edit arrives as `"42"` / `"true"`. Such
 * text (and date/enum text with surrounding whitespace, which the old editor
 * accepted and stored untrimmed) is converted to its typed value when it parses
 * cleanly under the workbench's own rules (`convertedFromText: true`, reported as a warning by the
 * apply derivation); text that does not parse is refused.
 */
export function checkEditedValueForItem(item: ReviewItem, value: unknown): EditedValueCheck {
  const itemName = item.metadata.name;
  if (item.spec.editable === false) {
    return {
      ok: false,
      code: "edited-value-not-editable",
      message: `ReviewItem ${itemName} is not editable (spec.editable: false), but the decision carries an edited value.`,
    };
  }
  const descriptor = item.spec.valueDescriptor;
  if (!descriptor || valueMatchesDescriptor(descriptor, value)) {
    return { ok: true, value, convertedFromText: false };
  }
  if (typeof value === "string") {
    const converted = editedValueFromEditorText(descriptor, value);
    if (converted !== undefined) {
      return { ok: true, value: converted, convertedFromText: true };
    }
  }
  const allowed = descriptor.type === "enum" && descriptor.enumValues?.length
    ? ` (one of: ${descriptor.enumValues.join(", ")})`
    : "";
  return {
    ok: false,
    code: "edited-value-type-mismatch",
    message: `ReviewItem ${itemName} declares value type ${descriptor.type}${allowed}, but the decision carries edited value ${JSON.stringify(value)}.`,
  };
}
