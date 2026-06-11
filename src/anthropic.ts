/**
 * Anthropic production adapters for Survey's pluggable interfaces.
 *
 * ADR 0003 §4 compliance: these implementations are PROPOSERS only. Every
 * output is a proposal (MappingProposal / ExtractedStatement) that goes
 * through the existing review/auto-accept machinery before counting.
 * Nothing here bypasses review.
 *
 * Subpath export: import from "@kontourai/survey/anthropic" — this module is
 * NOT re-exported from the main index.ts so consumers without @anthropic-ai/sdk
 * pay nothing.
 *
 * Injected client: both factories accept an optional pre-built client so tests
 * can inject a fake without hitting the network. If no client is provided, one
 * is constructed from opts.apiKey (falling back to process.env.ANTHROPIC_API_KEY).
 */

import type { CanonicalClaimTarget, DerivationRule, TrustBundle } from "@kontourai/surface";
import type { MappingProposal, MappingProposer } from "./inquiry-mapping.js";
import type { ExtractedStatement, UtteranceClaimExtractor } from "./agent-utterance.js";

// ---------------------------------------------------------------------------
// Minimal client interface — mirrors @anthropic-ai/sdk Message API surface.
// Consumers can pass the real Anthropic client or any compatible mock.
// ---------------------------------------------------------------------------

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | AnthropicToolUseBlock;

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AnthropicMessageCreateParams {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools: AnthropicTool[];
  tool_choice: { type: "tool"; name: string };
}

/**
 * Minimal interface matching @anthropic-ai/sdk Anthropic.messages.create.
 * Accept the real SDK client or a test double.
 */
export interface AnthropicMessagesClient {
  create(params: AnthropicMessageCreateParams): Promise<AnthropicMessage>;
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface AnthropicAdapterOptions {
  /** Injected client (real or mock). If absent, one is built from apiKey. */
  client?: AnthropicMessagesClient;
  /** API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Defaults to "claude-sonnet-4-6". */
  model?: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Build or return a messages client from options.
 * Dynamic-imports @anthropic-ai/sdk only when no client is injected,
 * keeping the optional peer dep out of the eager module graph.
 */
async function resolveClient(opts: AnthropicAdapterOptions): Promise<AnthropicMessagesClient> {
  if (opts.client) return opts.client;

  // Dynamically load the SDK — only reachable when no client is injected.
  // Uses a variable module specifier so TypeScript does not try to resolve
  // the optional peer dep at compile time. At runtime the SDK must be installed.
  const sdkModule = "@anthropic-ai/sdk";
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const sdkImport = await (Function("m", "return import(m)")(sdkModule) as Promise<unknown>);
  const { default: Anthropic } = sdkImport as {
    default: new (opts: { apiKey: string }) => { messages: AnthropicMessagesClient };
  };

  const apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "AnthropicAdapter: no API key. Provide opts.apiKey, set ANTHROPIC_API_KEY, or inject opts.client.",
    );
  }

  const sdk = new Anthropic({ apiKey });
  return sdk.messages;
}

// ---------------------------------------------------------------------------
// JSON tool schemas
// ---------------------------------------------------------------------------

const MAPPING_PROPOSAL_TOOL: AnthropicTool = {
  name: "submit_mapping_proposals",
  description:
    "Submit an array of candidate mappings from the natural-language question to registered canonical claim targets or derivation rules. " +
    "You are PROPOSING for human review — every proposal must carry a rationale and confidence score. " +
    "Per ADR 0003 §4, proposals are reviewable records; they do not resolve questions by themselves.",
  input_schema: {
    type: "object",
    properties: {
      proposals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            proposedTargetSubjectType: {
              type: "string",
              description: "subjectType of the canonical claim target (omit if proposing a rule)",
            },
            proposedTargetSubjectId: {
              type: "string",
              description: "subjectId of the canonical claim target (omit if proposing a rule)",
            },
            proposedTargetFieldOrBehavior: {
              type: "string",
              description: "fieldOrBehavior of the canonical claim target (omit if proposing a rule)",
            },
            proposedRuleId: {
              type: "string",
              description: "Id of the derivation rule this question maps to (omit if proposing a target)",
            },
            confidence: {
              type: "number",
              description: "Confidence in this mapping (0.0–1.0)",
            },
            rationale: {
              type: "string",
              description: "Human-readable explanation of why this mapping is proposed",
            },
            excerpt: {
              type: "string",
              description: "Verbatim excerpt from the question that drove the suggestion",
            },
          },
          required: ["confidence", "rationale"],
        },
      },
    },
    required: ["proposals"],
  },
};

const UTTERANCE_EXTRACTION_TOOL: AnthropicTool = {
  name: "submit_extracted_statements",
  description:
    "Submit an array of factual statements extracted from the agent utterance. " +
    "Each statement maps to a canonical claim target with full provenance (excerpt, span, confidence). " +
    "You are EXTRACTING FOR REVIEW — output is a proposal queue, not authoritative truth. " +
    "Per ADR 0003 §4, every extracted statement requires a rationale and confidence score.",
  input_schema: {
    type: "object",
    properties: {
      statements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            subjectType: {
              type: "string",
              description: "The canonical subjectType (use 'unknown' if uncertain)",
            },
            subjectId: {
              type: "string",
              description: "The entity or resource the statement is about",
            },
            fieldOrBehavior: {
              type: "string",
              description: "The property or behavior being claimed",
            },
            value: {
              description: "The claimed value (string, number, boolean, or null)",
            },
            excerpt: {
              type: "string",
              description: "Verbatim text from the utterance that contains this claim",
            },
            spanStart: {
              type: "number",
              description: "0-indexed character offset where the excerpt starts in the utterance",
            },
            spanEnd: {
              type: "number",
              description: "0-indexed character offset where the excerpt ends in the utterance",
            },
            confidence: {
              type: "number",
              description: "Extraction confidence (0.0–1.0)",
            },
          },
          required: ["subjectId", "fieldOrBehavior", "excerpt", "confidence"],
        },
      },
    },
    required: ["statements"],
  },
};

// ---------------------------------------------------------------------------
// Raw proposal shape from tool output
// ---------------------------------------------------------------------------

interface RawMappingProposalItem {
  proposedTargetSubjectType?: unknown;
  proposedTargetSubjectId?: unknown;
  proposedTargetFieldOrBehavior?: unknown;
  proposedRuleId?: unknown;
  confidence?: unknown;
  rationale?: unknown;
  excerpt?: unknown;
}

interface RawExtractedStatementItem {
  subjectType?: unknown;
  subjectId?: unknown;
  fieldOrBehavior?: unknown;
  value?: unknown;
  excerpt?: unknown;
  spanStart?: unknown;
  spanEnd?: unknown;
  confidence?: unknown;
}

// ---------------------------------------------------------------------------
// Tool output parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first tool_use block with the given name from a message.
 * Returns undefined if not found (malformed output is rejected, never silently accepted).
 */
function extractToolUseInput(message: AnthropicMessage, toolName: string): unknown {
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === toolName) {
      return block.input;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !isFinite(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// createAnthropicMappingProposer
// ---------------------------------------------------------------------------

/**
 * Create a MappingProposer backed by Anthropic's API using forced tool-use.
 *
 * ADR 0003 §4: returns PROPOSALS only — they flow through the existing
 * review/auto-accept machinery before counting as mappings.
 *
 * Tool output is validated strictly: malformed items (missing required fields,
 * out-of-range confidence, no target and no rule) are filtered out rather than
 * silently accepted.
 */
export function createAnthropicMappingProposer(opts: AnthropicAdapterOptions = {}): MappingProposer {
  const model = opts.model ?? DEFAULT_MODEL;

  return {
    name: `anthropic-mapping-proposer:${model}`,

    async propose(
      question: string,
      context: { bundle?: TrustBundle; rules?: DerivationRule[] },
    ): Promise<MappingProposal[]> {
      const client = await resolveClient(opts);

      // Build context summary for the prompt
      const claimsContext = buildClaimsContext(context.bundle);
      const rulesContext = buildRulesContext(context.rules);

      const systemPrompt = [
        "You are a mapping proposer for the Kontour trust ledger.",
        "Your role is to PROPOSE (not decide) how a natural-language question maps to a registered canonical claim or derivation rule.",
        "Every proposal you return will be reviewed by a human or auto-accept policy before it counts.",
        "Do not make up claim targets that are not in the registered list below.",
        "Return only proposals you genuinely believe are plausible mappings — with honest confidence scores.",
        "",
        claimsContext,
        rulesContext,
      ]
        .filter(Boolean)
        .join("\n");

      const userMessage = `Question to map: "${question}"`;

      const message = await client.create({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: `${systemPrompt}\n\n${userMessage}` }],
        tools: [MAPPING_PROPOSAL_TOOL],
        tool_choice: { type: "tool", name: "submit_mapping_proposals" },
      });

      const input = extractToolUseInput(message, "submit_mapping_proposals");
      if (!isRecord(input)) return [];

      const rawProposals = input["proposals"];
      if (!isArray(rawProposals)) return [];

      const proposedAt = new Date().toISOString();
      const results: MappingProposal[] = [];

      for (const item of rawProposals) {
        const proposal = parseMappingProposalItem(item, question, model, proposedAt);
        if (proposal) results.push(proposal);
      }

      return results;
    },
  };
}

function parseMappingProposalItem(
  item: unknown,
  question: string,
  proposedBy: string,
  proposedAt: string,
): MappingProposal | undefined {
  if (!isRecord(item)) return undefined;

  const raw = item as RawMappingProposalItem;

  const confidence = numberInRange(raw.confidence, 0, 1);
  const rationale = stringOrUndefined(raw.rationale);

  // Both required fields must be present
  if (confidence === undefined || rationale === undefined) return undefined;

  const subjectType = stringOrUndefined(raw.proposedTargetSubjectType);
  const subjectId = stringOrUndefined(raw.proposedTargetSubjectId);
  const fieldOrBehavior = stringOrUndefined(raw.proposedTargetFieldOrBehavior);
  const ruleId = stringOrUndefined(raw.proposedRuleId);
  const excerpt = stringOrUndefined(raw.excerpt);

  // Exactly one of (target triple) or ruleId must be present
  const hasTarget = subjectType !== undefined && subjectId !== undefined && fieldOrBehavior !== undefined;
  const hasRule = ruleId !== undefined;

  if (!hasTarget && !hasRule) return undefined;

  const proposedTarget: CanonicalClaimTarget | undefined = hasTarget
    ? { subjectType: subjectType!, subjectId: subjectId!, fieldOrBehavior: fieldOrBehavior! }
    : undefined;

  const id = `proposal.anthropic.${encodeId(question)}.${Date.now()}`;

  return {
    id,
    question,
    proposedTarget,
    proposedRuleId: hasRule ? ruleId : undefined,
    confidence,
    rationale,
    excerpt,
    proposedBy,
    proposedAt,
  };
}

// ---------------------------------------------------------------------------
// createAnthropicUtteranceExtractor
// ---------------------------------------------------------------------------

/**
 * Create a UtteranceClaimExtractor backed by Anthropic's API using forced tool-use.
 *
 * ADR 0003 §4: returns EXTRACTED STATEMENTS only — they carry full provenance
 * (excerpt, span, extractor name, confidence) and flow through the Inquiry
 * pipeline. They are never treated as authoritative.
 *
 * Malformed tool output is rejected/filtered — items missing required fields
 * (subjectId, fieldOrBehavior, excerpt, confidence) are dropped.
 */
export function createAnthropicUtteranceExtractor(opts: AnthropicAdapterOptions = {}): UtteranceClaimExtractor {
  const model = opts.model ?? DEFAULT_MODEL;

  return {
    name: `anthropic-utterance-extractor:${model}`,

    async extract(utterance: string): Promise<ExtractedStatement[]> {
      const client = await resolveClient(opts);

      const systemPrompt = [
        "You are a factual statement extractor for the Kontour trust ledger.",
        "Your role is to identify every factual claim in the agent utterance and extract it with full provenance.",
        "Each extracted statement will be reviewed for trust coverage — you are NOT deciding truth, only extracting for review.",
        "Extract only statements that assert factual properties of named entities.",
        "Skip opinions, predictions, and procedural descriptions.",
        "Provide honest confidence scores — low confidence for ambiguous phrasing.",
        "Include the exact verbatim excerpt and 0-indexed character span offsets.",
      ].join("\n");

      const userMessage = `Extract factual statements from this agent utterance:\n\n"${utterance}"`;

      const message = await client.create({
        model,
        max_tokens: 2048,
        messages: [{ role: "user", content: `${systemPrompt}\n\n${userMessage}` }],
        tools: [UTTERANCE_EXTRACTION_TOOL],
        tool_choice: { type: "tool", name: "submit_extracted_statements" },
      });

      const input = extractToolUseInput(message, "submit_extracted_statements");
      if (!isRecord(input)) return [];

      const rawStatements = input["statements"];
      if (!isArray(rawStatements)) return [];

      const results: ExtractedStatement[] = [];

      for (const item of rawStatements) {
        const statement = parseExtractedStatementItem(item, utterance);
        if (statement) results.push(statement);
      }

      return results;
    },
  };
}

function parseExtractedStatementItem(item: unknown, utterance: string): ExtractedStatement | undefined {
  if (!isRecord(item)) return undefined;

  const raw = item as RawExtractedStatementItem;

  const subjectId = stringOrUndefined(raw.subjectId);
  const fieldOrBehavior = stringOrUndefined(raw.fieldOrBehavior);
  const excerpt = stringOrUndefined(raw.excerpt);
  const confidence = numberInRange(raw.confidence, 0, 1);

  // All required fields must be present
  if (!subjectId || !fieldOrBehavior || !excerpt || confidence === undefined) return undefined;

  const subjectType = stringOrUndefined(raw.subjectType) ?? "unknown";

  // Validate span if provided — both start and end must be valid integers
  // within the utterance length
  let span: { start: number; end: number } | undefined;
  if (typeof raw.spanStart === "number" && typeof raw.spanEnd === "number") {
    const start = Math.trunc(raw.spanStart);
    const end = Math.trunc(raw.spanEnd);
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end > start &&
      end <= utterance.length
    ) {
      span = { start, end };
    }
  }

  return {
    target: { subjectType, subjectId, fieldOrBehavior },
    value: raw.value ?? undefined,
    excerpt,
    span,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Prompt context builders
// ---------------------------------------------------------------------------

function buildClaimsContext(bundle?: TrustBundle): string {
  if (!bundle || bundle.claims.length === 0) return "";

  const lines = [
    "Registered canonical claim targets (use ONLY these as proposedTarget):",
    ...bundle.claims.map(
      (c) => `  - subjectType="${c.subjectType}" subjectId="${c.subjectId}" fieldOrBehavior="${c.fieldOrBehavior}"`,
    ),
  ];
  return lines.join("\n");
}

function buildRulesContext(rules?: DerivationRule[]): string {
  if (!rules || rules.length === 0) return "";

  const lines = [
    "Registered derivation rules (use rule id as proposedRuleId):",
    ...rules.map((r) => `  - id="${r.id}" name="${r.name}"`),
  ];
  return lines.join("\n");
}

function encodeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .slice(0, 40);
}
