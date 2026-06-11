/**
 * Tests for Anthropic adapter implementations (createAnthropicMappingProposer,
 * createAnthropicUtteranceExtractor).
 *
 * All tests use an injected fake client — no network calls.
 *
 * Covers:
 * - Proposer returns well-formed MappingProposals
 * - Extractor returns ExtractedStatements with spans
 * - Malformed tool output is rejected/filtered, never silently accepted
 * - ADR 0003 §4: proposals only, no review bypass
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAnthropicMappingProposer, createAnthropicUtteranceExtractor } from "../src/anthropic.js";
import type { AnthropicMessage, AnthropicMessagesClient, AnthropicMessageCreateParams } from "../src/anthropic.js";
import type { TrustBundle } from "@kontourai/surface";

// ---------------------------------------------------------------------------
// Fake client helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake AnthropicMessage that returns the given tool_use input.
 */
function fakeMessage(toolName: string, input: unknown): AnthropicMessage {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tool_fake_1",
        name: toolName,
        input,
      },
    ],
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

/**
 * Build a fake client that captures the create call and returns a fixed message.
 */
function fakeClient(response: AnthropicMessage): AnthropicMessagesClient & { calls: AnthropicMessageCreateParams[] } {
  const calls: AnthropicMessageCreateParams[] = [];
  return {
    calls,
    async create(params: AnthropicMessageCreateParams): Promise<AnthropicMessage> {
      calls.push(params);
      return response;
    },
  };
}

/**
 * A fake client that returns a message with no tool_use blocks (simulates model
 * returning text instead of using the tool).
 */
function fakeClientNoTool(): AnthropicMessagesClient {
  return {
    async create(): Promise<AnthropicMessage> {
      return {
        id: "msg_notool",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "I cannot map that question." }],
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}

function makeBundle(): TrustBundle {
  return {
    schemaVersion: 3,
    source: "test",
    claims: [
      {
        id: "claim.entity-1.registration-status",
        subjectType: "public-record.entity",
        subjectId: "entity-1",
        surface: "public-record.profile",
        claimType: "public-data.field",
        fieldOrBehavior: "registration-status",
        value: "ACTIVE",
        status: "verified",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
    evidence: [],
    policies: [],
    events: [],
  };
}

// ---------------------------------------------------------------------------
// createAnthropicMappingProposer
// ---------------------------------------------------------------------------

describe("createAnthropicMappingProposer", () => {
  it("returns a MappingProposer with a name that includes the model", () => {
    const proposer = createAnthropicMappingProposer({
      client: fakeClient(fakeMessage("submit_mapping_proposals", { proposals: [] })),
      model: "claude-sonnet-4-6",
    });

    assert.ok(proposer.name.includes("claude-sonnet-4-6"), `name should include model; got "${proposer.name}"`);
  });

  it("returns well-formed MappingProposals from a valid tool response", async () => {
    const toolInput = {
      proposals: [
        {
          proposedTargetSubjectType: "public-record.entity",
          proposedTargetSubjectId: "entity-1",
          proposedTargetFieldOrBehavior: "registration-status",
          confidence: 0.9,
          rationale: "The question asks about entity-1 registration status.",
          excerpt: "entity-1 active",
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_mapping_proposals", toolInput));
    const proposer = createAnthropicMappingProposer({ client });
    const bundle = makeBundle();

    const proposals = await proposer.propose("Is entity-1 active?", { bundle });

    assert.equal(proposals.length, 1);
    const p = proposals[0]!;
    assert.equal(p.proposedTarget?.subjectType, "public-record.entity");
    assert.equal(p.proposedTarget?.subjectId, "entity-1");
    assert.equal(p.proposedTarget?.fieldOrBehavior, "registration-status");
    assert.equal(p.confidence, 0.9);
    assert.ok(p.rationale.length > 0);
    assert.equal(p.excerpt, "entity-1 active");
    assert.ok(p.id, "proposal should have an id");
    assert.ok(p.proposedBy, "proposal should have proposedBy");
    assert.ok(p.proposedAt, "proposal should have proposedAt");
  });

  it("returns proposals that map to a rule (proposedRuleId)", async () => {
    const toolInput = {
      proposals: [
        {
          proposedRuleId: "rule.release-ready",
          confidence: 0.75,
          rationale: "Question is about release readiness.",
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_mapping_proposals", toolInput));
    const proposer = createAnthropicMappingProposer({ client });

    const proposals = await proposer.propose("Is the release ready?", {});

    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.proposedRuleId, "rule.release-ready");
    assert.equal(proposals[0]?.proposedTarget, undefined);
  });

  it("filters out proposals missing required fields (confidence)", async () => {
    const toolInput = {
      proposals: [
        {
          proposedTargetSubjectType: "entity",
          proposedTargetSubjectId: "entity-1",
          proposedTargetFieldOrBehavior: "status",
          // confidence intentionally missing
          rationale: "some rationale",
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_mapping_proposals", toolInput));
    const proposer = createAnthropicMappingProposer({ client });

    const proposals = await proposer.propose("Is entity-1 active?", {});
    assert.equal(proposals.length, 0, "proposals missing confidence must be filtered");
  });

  it("filters out proposals missing required fields (rationale)", async () => {
    const toolInput = {
      proposals: [
        {
          proposedTargetSubjectType: "entity",
          proposedTargetSubjectId: "entity-1",
          proposedTargetFieldOrBehavior: "status",
          confidence: 0.8,
          // rationale intentionally missing
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_mapping_proposals", toolInput));
    const proposer = createAnthropicMappingProposer({ client });

    const proposals = await proposer.propose("Is entity-1 active?", {});
    assert.equal(proposals.length, 0, "proposals missing rationale must be filtered");
  });

  it("filters out proposals with out-of-range confidence", async () => {
    const toolInput = {
      proposals: [
        {
          proposedTargetSubjectType: "entity",
          proposedTargetSubjectId: "entity-1",
          proposedTargetFieldOrBehavior: "status",
          confidence: 1.5, // out of range
          rationale: "some rationale",
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_mapping_proposals", toolInput));
    const proposer = createAnthropicMappingProposer({ client });

    const proposals = await proposer.propose("Is entity-1 active?", {});
    assert.equal(proposals.length, 0, "proposals with out-of-range confidence must be filtered");
  });

  it("filters out proposals with neither target nor ruleId", async () => {
    const toolInput = {
      proposals: [
        {
          confidence: 0.8,
          rationale: "some rationale",
          // no proposedTarget fields, no proposedRuleId
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_mapping_proposals", toolInput));
    const proposer = createAnthropicMappingProposer({ client });

    const proposals = await proposer.propose("Is entity-1 active?", {});
    assert.equal(proposals.length, 0, "proposals with no target or rule must be filtered");
  });

  it("returns empty array when model does not use the tool", async () => {
    const proposer = createAnthropicMappingProposer({ client: fakeClientNoTool() });

    const proposals = await proposer.propose("Is entity-1 active?", {});
    assert.equal(proposals.length, 0);
  });

  it("returns empty array when proposals array is empty", async () => {
    const client = fakeClient(fakeMessage("submit_mapping_proposals", { proposals: [] }));
    const proposer = createAnthropicMappingProposer({ client });

    const proposals = await proposer.propose("Is entity-1 active?", {});
    assert.equal(proposals.length, 0);
  });

  it("uses forced tool_choice in the API call", async () => {
    const client = fakeClient(fakeMessage("submit_mapping_proposals", { proposals: [] }));
    const proposer = createAnthropicMappingProposer({ client });

    await proposer.propose("Is entity-1 active?", {});

    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0]?.tool_choice.type, "tool");
    assert.equal(client.calls[0]?.tool_choice.name, "submit_mapping_proposals");
  });

  it("passes multiple valid proposals through", async () => {
    const toolInput = {
      proposals: [
        {
          proposedTargetSubjectType: "entity",
          proposedTargetSubjectId: "entity-1",
          proposedTargetFieldOrBehavior: "status",
          confidence: 0.9,
          rationale: "Strong match.",
        },
        {
          proposedTargetSubjectType: "entity",
          proposedTargetSubjectId: "entity-1",
          proposedTargetFieldOrBehavior: "registration-status",
          confidence: 0.7,
          rationale: "Possible match.",
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_mapping_proposals", toolInput));
    const proposer = createAnthropicMappingProposer({ client });

    const proposals = await proposer.propose("Is entity-1 registered?", {});
    assert.equal(proposals.length, 2);
  });

  it("filters non-object items in proposals array", async () => {
    const toolInput = {
      proposals: ["not-an-object", null, 42],
    };

    const client = fakeClient(fakeMessage("submit_mapping_proposals", toolInput));
    const proposer = createAnthropicMappingProposer({ client });

    const proposals = await proposer.propose("Is entity-1 active?", {});
    assert.equal(proposals.length, 0, "non-object items must be filtered");
  });
});

// ---------------------------------------------------------------------------
// createAnthropicUtteranceExtractor
// ---------------------------------------------------------------------------

describe("createAnthropicUtteranceExtractor", () => {
  it("returns a UtteranceClaimExtractor with a name that includes the model", () => {
    const extractor = createAnthropicUtteranceExtractor({
      client: fakeClient(fakeMessage("submit_extracted_statements", { statements: [] })),
      model: "claude-sonnet-4-6",
    });

    assert.ok(extractor.name.includes("claude-sonnet-4-6"), `name should include model; got "${extractor.name}"`);
  });

  it("returns well-formed ExtractedStatements with spans", async () => {
    const utterance = "The api-gateway service uptime is 99.9% this quarter.";
    const toolInput = {
      statements: [
        {
          subjectType: "service",
          subjectId: "api-gateway",
          fieldOrBehavior: "uptime",
          value: "99.9%",
          excerpt: "api-gateway service uptime is 99.9%",
          spanStart: 4,
          spanEnd: 39,
          confidence: 0.88,
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_extracted_statements", toolInput));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract(utterance);

    assert.equal(statements.length, 1);
    const s = statements[0]!;
    assert.equal(s.target.subjectType, "service");
    assert.equal(s.target.subjectId, "api-gateway");
    assert.equal(s.target.fieldOrBehavior, "uptime");
    assert.equal(s.value, "99.9%");
    assert.equal(s.excerpt, "api-gateway service uptime is 99.9%");
    assert.ok(s.span, "span should be set");
    assert.equal(s.span?.start, 4);
    assert.equal(s.span?.end, 39);
    assert.equal(s.confidence, 0.88);
  });

  it("defaults subjectType to 'unknown' when not provided", async () => {
    const utterance = "entity-1 status is active";
    const toolInput = {
      statements: [
        {
          // subjectType intentionally omitted
          subjectId: "entity-1",
          fieldOrBehavior: "status",
          excerpt: "entity-1 status is active",
          spanStart: 0,
          spanEnd: 25,
          confidence: 0.7,
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_extracted_statements", toolInput));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract(utterance);
    assert.equal(statements.length, 1);
    assert.equal(statements[0]?.target.subjectType, "unknown");
  });

  it("filters out statements missing subjectId", async () => {
    const utterance = "something is active";
    const toolInput = {
      statements: [
        {
          // subjectId intentionally missing
          fieldOrBehavior: "status",
          excerpt: "something is active",
          confidence: 0.7,
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_extracted_statements", toolInput));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract(utterance);
    assert.equal(statements.length, 0, "statements missing subjectId must be filtered");
  });

  it("filters out statements missing fieldOrBehavior", async () => {
    const utterance = "entity-1 is active";
    const toolInput = {
      statements: [
        {
          subjectId: "entity-1",
          // fieldOrBehavior intentionally missing
          excerpt: "entity-1 is active",
          confidence: 0.7,
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_extracted_statements", toolInput));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract(utterance);
    assert.equal(statements.length, 0, "statements missing fieldOrBehavior must be filtered");
  });

  it("filters out statements missing excerpt", async () => {
    const utterance = "entity-1 status is active";
    const toolInput = {
      statements: [
        {
          subjectId: "entity-1",
          fieldOrBehavior: "status",
          // excerpt intentionally missing
          confidence: 0.7,
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_extracted_statements", toolInput));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract(utterance);
    assert.equal(statements.length, 0, "statements missing excerpt must be filtered");
  });

  it("filters out statements missing confidence", async () => {
    const utterance = "entity-1 status is active";
    const toolInput = {
      statements: [
        {
          subjectId: "entity-1",
          fieldOrBehavior: "status",
          excerpt: "entity-1 status is active",
          // confidence intentionally missing
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_extracted_statements", toolInput));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract(utterance);
    assert.equal(statements.length, 0, "statements missing confidence must be filtered");
  });

  it("rejects spans where start >= end", async () => {
    const utterance = "entity-1 status is active";
    const toolInput = {
      statements: [
        {
          subjectId: "entity-1",
          fieldOrBehavior: "status",
          excerpt: "entity-1 status is active",
          spanStart: 10,
          spanEnd: 5, // end < start: invalid
          confidence: 0.7,
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_extracted_statements", toolInput));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract(utterance);
    // Statement should be accepted but span should be dropped
    assert.equal(statements.length, 1);
    assert.equal(statements[0]?.span, undefined, "invalid span should be dropped");
  });

  it("rejects spans where end > utterance.length", async () => {
    const utterance = "short";
    const toolInput = {
      statements: [
        {
          subjectId: "entity-1",
          fieldOrBehavior: "status",
          excerpt: "short",
          spanStart: 0,
          spanEnd: 100, // beyond utterance length
          confidence: 0.7,
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_extracted_statements", toolInput));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract(utterance);
    assert.equal(statements.length, 1);
    assert.equal(statements[0]?.span, undefined, "out-of-bounds span should be dropped");
  });

  it("returns empty array when model does not use the tool", async () => {
    const extractor = createAnthropicUtteranceExtractor({ client: fakeClientNoTool() });

    const statements = await extractor.extract("entity-1 status is active");
    assert.equal(statements.length, 0);
  });

  it("returns empty array when statements array is empty", async () => {
    const client = fakeClient(fakeMessage("submit_extracted_statements", { statements: [] }));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract("entity-1 status is active");
    assert.equal(statements.length, 0);
  });

  it("uses forced tool_choice in the API call", async () => {
    const client = fakeClient(fakeMessage("submit_extracted_statements", { statements: [] }));
    const extractor = createAnthropicUtteranceExtractor({ client });

    await extractor.extract("entity-1 status is active");

    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0]?.tool_choice.type, "tool");
    assert.equal(client.calls[0]?.tool_choice.name, "submit_extracted_statements");
  });

  it("passes multiple valid statements through", async () => {
    const utterance = "api-gateway uptime is 99.9. db-cluster lag is 12ms.";
    const toolInput = {
      statements: [
        {
          subjectId: "api-gateway",
          fieldOrBehavior: "uptime",
          excerpt: "api-gateway uptime is 99.9",
          spanStart: 0,
          spanEnd: 26,
          confidence: 0.9,
        },
        {
          subjectId: "db-cluster",
          fieldOrBehavior: "lag",
          excerpt: "db-cluster lag is 12ms",
          spanStart: 28,
          spanEnd: 50,
          confidence: 0.85,
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_extracted_statements", toolInput));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract(utterance);
    assert.equal(statements.length, 2);
    assert.equal(statements[0]?.target.subjectId, "api-gateway");
    assert.equal(statements[1]?.target.subjectId, "db-cluster");
  });

  it("filters non-object items in statements array", async () => {
    const toolInput = {
      statements: ["not-an-object", null, 42],
    };

    const client = fakeClient(fakeMessage("submit_extracted_statements", toolInput));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract("entity-1 status is active");
    assert.equal(statements.length, 0, "non-object items must be filtered");
  });
});

// ---------------------------------------------------------------------------
// ADR 0003 §4 compliance
// ---------------------------------------------------------------------------

describe("Anthropic adapters — ADR 0003 §4 compliance (proposals only)", () => {
  it("MappingProposer produces proposals with id, question, proposedBy, proposedAt", async () => {
    const toolInput = {
      proposals: [
        {
          proposedTargetSubjectType: "entity",
          proposedTargetSubjectId: "entity-1",
          proposedTargetFieldOrBehavior: "status",
          confidence: 0.8,
          rationale: "Plausible match.",
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_mapping_proposals", toolInput));
    const proposer = createAnthropicMappingProposer({ client, model: "test-model" });

    const proposals = await proposer.propose("Is entity-1 active?", {});
    const p = proposals[0]!;

    // Every proposal must carry full provenance
    assert.ok(p.id, "must have id");
    assert.equal(p.question, "Is entity-1 active?");
    assert.ok(p.proposedBy, "must have proposedBy");
    assert.ok(p.proposedAt, "must have proposedAt");
  });

  it("ExtractedStatement carries confidence and excerpt for every item", async () => {
    const utterance = "entity-1 status is active";
    const toolInput = {
      statements: [
        {
          subjectId: "entity-1",
          fieldOrBehavior: "status",
          excerpt: "entity-1 status is active",
          confidence: 0.75,
        },
      ],
    };

    const client = fakeClient(fakeMessage("submit_extracted_statements", toolInput));
    const extractor = createAnthropicUtteranceExtractor({ client });

    const statements = await extractor.extract(utterance);
    const s = statements[0]!;

    // Every statement must carry full provenance
    assert.ok(s.excerpt, "must have excerpt");
    assert.equal(typeof s.confidence, "number", "must have numeric confidence");
    assert.ok(s.confidence >= 0 && s.confidence <= 1, "confidence must be in [0,1]");
  });
});
