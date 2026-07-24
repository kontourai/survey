export interface PortablePdfTextRange {
  start: number;
  end: number;
}

export interface PortablePdfBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PortablePdfPageGeometry {
  pageNumber: number;
  width: number;
  height: number;
  unit: "points" | "pixels" | "normalized";
  rotation?: 0 | 90 | 180 | 270;
}

export interface PortablePdfTextElement {
  kind: "heading" | "paragraph" | "list" | "table" | "table-cell" | "figure" | "other";
  providerType?: string;
  pageNumber: number;
  range: PortablePdfTextRange;
  bounds?: PortablePdfBoundingBox;
}

export interface PortablePdfTableCell {
  rowIndex: number;
  columnIndex: number;
  rowSpan?: number;
  columnSpan?: number;
  range: PortablePdfTextRange;
  bounds?: PortablePdfBoundingBox;
}

export interface PortablePdfTable {
  pageNumber: number;
  bounds?: PortablePdfBoundingBox;
  cells: PortablePdfTableCell[];
}

export interface PortablePdfLayout {
  pages?: PortablePdfPageGeometry[];
  elements: PortablePdfTextElement[];
  tables?: PortablePdfTable[];
}

export interface PortablePdfRegionContext {
  pages: number[];
  elements: PortablePdfTextElement[];
  tableCells: Array<{
    pageNumber: number;
    tableIndex: number;
    cell: PortablePdfTableCell;
  }>;
}

const MAX_LAYOUT_ITEMS = 10_000;
const COORDINATE_UNITS = new Set(["points", "pixels", "normalized"]);
const ROTATIONS = new Set([0, 90, 180, 270]);
const ELEMENT_KINDS = new Set(["heading", "paragraph", "list", "table", "table-cell", "figure", "other"]);

export function validatePortablePdfLayout(value: unknown, textLength: number): PortablePdfLayout {
  if (!Number.isSafeInteger(textLength) || textLength < 0) throw new Error("PDF layout text length is invalid.");
  const layout = record(value, "result.pdfLayout");
  exact(layout, ["elements"], ["pages", "tables"], "result.pdfLayout");
  const rawPages = optionalArray(layout.pages, "result.pdfLayout.pages");
  const rawElements = boundedArray(layout.elements, "result.pdfLayout.elements");
  const rawTables = optionalArray(layout.tables, "result.pdfLayout.tables");
  const pages: PortablePdfPageGeometry[] | undefined = rawPages?.map((value, index) =>
    validatePage(value, `result.pdfLayout.pages[${index}]`));
  const pageByNumber = new Map<number, PortablePdfPageGeometry>();
  for (const page of pages ?? []) {
    if (pageByNumber.has(page.pageNumber)) throw new Error("PDF layout page numbers must be unique.");
    pageByNumber.set(page.pageNumber, page);
  }
  const pageExists = (pageNumber: number): boolean => pageByNumber.size === 0 || pageByNumber.has(pageNumber);
  const elements = rawElements.map((value, index) =>
    validateElement(value, `result.pdfLayout.elements[${index}]`, textLength, pageByNumber, pageExists));
  const tables: PortablePdfTable[] | undefined = rawTables?.map((value, index) =>
    validateTable(value, `result.pdfLayout.tables[${index}]`, textLength, pageByNumber, pageExists));
  pages?.sort((left, right) => left.pageNumber - right.pageNumber);
  elements.sort((left, right) =>
    left.range.start - right.range.start ||
    left.range.end - right.range.end ||
    left.pageNumber - right.pageNumber ||
    left.kind.localeCompare(right.kind));
  tables?.sort((left, right) =>
    left.pageNumber - right.pageNumber ||
    (left.cells[0]?.range.start ?? 0) - (right.cells[0]?.range.start ?? 0));
  return {
    ...(pages ? { pages } : {}),
    elements,
    ...(tables ? { tables } : {}),
  };
}

export function resolvePortablePdfRegion(
  layout: PortablePdfLayout,
  locator: string,
): PortablePdfRegionContext | undefined {
  const match = /^chars:(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(locator);
  if (!match) return undefined;
  const span = { start: Number(match[1]), end: Number(match[2]) };
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.end <= span.start) return undefined;
  const elements = layout.elements.filter((element) => overlaps(element.range, span));
  const tableCells = (layout.tables ?? []).flatMap((table, tableIndex) =>
    table.cells
      .filter((cell) => overlaps(cell.range, span))
      .map((cell) => ({ pageNumber: table.pageNumber, tableIndex, cell })));
  const pages = [...new Set([
    ...elements.map((element) => element.pageNumber),
    ...tableCells.map((entry) => entry.pageNumber),
  ])].sort((left, right) => left - right);
  return { pages, elements, tableCells };
}

function validatePage(value: unknown, subject: string): PortablePdfPageGeometry {
  const page = record(value, subject);
  exact(page, ["pageNumber", "width", "height", "unit"], ["rotation"], subject);
  positiveInteger(page.pageNumber, `${subject}.pageNumber`);
  positiveFinite(page.width, `${subject}.width`);
  positiveFinite(page.height, `${subject}.height`);
  if (!COORDINATE_UNITS.has(page.unit as string)) throw new Error(`${subject}.unit is invalid.`);
  if (page.rotation !== undefined && !ROTATIONS.has(page.rotation as number)) throw new Error(`${subject}.rotation is invalid.`);
  return {
    pageNumber: page.pageNumber as number,
    width: page.width as number,
    height: page.height as number,
    unit: page.unit as PortablePdfPageGeometry["unit"],
    ...(page.rotation === undefined ? {} : { rotation: page.rotation as PortablePdfPageGeometry["rotation"] }),
  };
}

function validateElement(
  value: unknown,
  subject: string,
  textLength: number,
  pages: Map<number, PortablePdfPageGeometry>,
  pageExists: (pageNumber: number) => boolean,
): PortablePdfTextElement {
  const element = record(value, subject);
  exact(element, ["kind", "pageNumber", "range"], ["providerType", "bounds"], subject);
  if (!ELEMENT_KINDS.has(element.kind as string)) throw new Error(`${subject}.kind is invalid.`);
  positiveInteger(element.pageNumber, `${subject}.pageNumber`);
  if (!pageExists(element.pageNumber as number)) throw new Error(`${subject}.pageNumber is not declared.`);
  if (element.providerType !== undefined && typeof element.providerType !== "string") throw new Error(`${subject}.providerType is invalid.`);
  return {
    kind: element.kind as PortablePdfTextElement["kind"],
    ...(element.providerType === undefined ? {} : { providerType: element.providerType }),
    pageNumber: element.pageNumber as number,
    range: validateRange(element.range, `${subject}.range`, textLength),
    ...(element.bounds === undefined ? {} : {
      bounds: validateBounds(element.bounds, `${subject}.bounds`, pages.get(element.pageNumber as number)),
    }),
  };
}

function validateTable(
  value: unknown,
  subject: string,
  textLength: number,
  pages: Map<number, PortablePdfPageGeometry>,
  pageExists: (pageNumber: number) => boolean,
): PortablePdfTable {
  const table = record(value, subject);
  exact(table, ["pageNumber", "cells"], ["bounds"], subject);
  positiveInteger(table.pageNumber, `${subject}.pageNumber`);
  if (!pageExists(table.pageNumber as number)) throw new Error(`${subject}.pageNumber is not declared.`);
  const occupied = new Set<string>();
  const cells = boundedArray(table.cells, `${subject}.cells`).map((value, index) => {
    const cellSubject = `${subject}.cells[${index}]`;
    const cell = record(value, cellSubject);
    exact(cell, ["rowIndex", "columnIndex", "range"], ["rowSpan", "columnSpan", "bounds"], cellSubject);
    nonnegativeInteger(cell.rowIndex, `${cellSubject}.rowIndex`);
    nonnegativeInteger(cell.columnIndex, `${cellSubject}.columnIndex`);
    if (cell.rowSpan !== undefined) positiveInteger(cell.rowSpan, `${cellSubject}.rowSpan`);
    if (cell.columnSpan !== undefined) positiveInteger(cell.columnSpan, `${cellSubject}.columnSpan`);
    const key = `${cell.rowIndex}:${cell.columnIndex}`;
    if (occupied.has(key)) throw new Error(`${subject} contains duplicate table coordinates.`);
    occupied.add(key);
    return {
      rowIndex: cell.rowIndex as number,
      columnIndex: cell.columnIndex as number,
      ...(cell.rowSpan === undefined ? {} : { rowSpan: cell.rowSpan as number }),
      ...(cell.columnSpan === undefined ? {} : { columnSpan: cell.columnSpan as number }),
      range: validateRange(cell.range, `${cellSubject}.range`, textLength),
      ...(cell.bounds === undefined ? {} : {
        bounds: validateBounds(cell.bounds, `${cellSubject}.bounds`, pages.get(table.pageNumber as number)),
      }),
    };
  });
  cells.sort((left, right) =>
    left.rowIndex - right.rowIndex ||
    left.columnIndex - right.columnIndex ||
    left.range.start - right.range.start);
  return {
    pageNumber: table.pageNumber as number,
    ...(table.bounds === undefined ? {} : {
      bounds: validateBounds(table.bounds, `${subject}.bounds`, pages.get(table.pageNumber as number)),
    }),
    cells,
  };
}

function validateRange(value: unknown, subject: string, textLength: number): PortablePdfTextRange {
  const range = record(value, subject);
  exact(range, ["start", "end"], [], subject);
  nonnegativeInteger(range.start, `${subject}.start`);
  nonnegativeInteger(range.end, `${subject}.end`);
  if ((range.end as number) <= (range.start as number) || (range.end as number) > textLength) {
    throw new Error(`${subject} is outside the prepared text.`);
  }
  return { start: range.start as number, end: range.end as number };
}

function validateBounds(
  value: unknown,
  subject: string,
  page: PortablePdfPageGeometry | undefined,
): PortablePdfBoundingBox {
  const bounds = record(value, subject);
  exact(bounds, ["x", "y", "width", "height"], [], subject);
  nonnegativeFinite(bounds.x, `${subject}.x`);
  nonnegativeFinite(bounds.y, `${subject}.y`);
  positiveFinite(bounds.width, `${subject}.width`);
  positiveFinite(bounds.height, `${subject}.height`);
  const result = {
    x: bounds.x as number,
    y: bounds.y as number,
    width: bounds.width as number,
    height: bounds.height as number,
  };
  if (page && (result.x + result.width > page.width || result.y + result.height > page.height)) {
    throw new Error(`${subject} exceeds its page geometry.`);
  }
  return result;
}

function boundedArray(value: unknown, subject: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_LAYOUT_ITEMS) throw new Error(`${subject} must be a bounded array.`);
  return value;
}
function optionalArray(value: unknown, subject: string): unknown[] | undefined {
  return value === undefined ? undefined : boundedArray(value, subject);
}
function record(value: unknown, subject: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${subject} must be an object.`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: string[], optional: string[], subject: string): void {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${subject}.${key} is required.`);
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) throw new Error(`${subject}.${key} is unexpected.`);
}
function nonnegativeInteger(value: unknown, subject: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${subject} must be a non-negative safe integer.`);
}
function positiveInteger(value: unknown, subject: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${subject} must be a positive safe integer.`);
}
function nonnegativeFinite(value: unknown, subject: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${subject} must be a non-negative finite number.`);
}
function positiveFinite(value: unknown, subject: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${subject} must be a positive finite number.`);
}
function overlaps(left: PortablePdfTextRange, right: PortablePdfTextRange): boolean {
  return left.start < right.end && right.start < left.end;
}
