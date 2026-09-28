// Generates the portable extraction envelopes in this directory from a real
// Traverse build, so the fixtures have exactly the shape Traverse's serializer
// produces rather than a hand-written approximation.
//
// The envelopes were produced from kontourai/traverse at commit 107fe1a
// (branch fix/envelope-partial-confidence, the producer side of typed partial
// reasons, per-chunk coverage and optional confidence), built with
// `pnpm install --frozen-lockfile && pnpm run build`. Every run goes through
// Traverse's own `extract()` with an in-process fake provider (no network),
// then `serializePortableExtractionResult()`; the output is re-read through
// `deserializePortableExtractionResult()` so an envelope Traverse itself would
// reject can never be written.
//
// Usage (from this repository's root):
//   node tests/fixtures/traverse-envelopes/generate.mjs <path-to-traverse-checkout>
//
// Run ids and extraction times are minted by Traverse per run, so regenerating
// changes those values; everything else is deterministic.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const traverseRoot = process.argv[2];
if (!traverseRoot) {
  console.error("usage: node generate.mjs <path-to-traverse-checkout>");
  process.exit(2);
}
const traverse = await import(pathToFileURL(join(resolve(traverseRoot), "dist/src/index.js")).href);
const { createRelayExtractionProvider } = await import(pathToFileURL(join(resolve(traverseRoot), "dist/src/relay.js")).href);
const { FakeModelRuntime } = await import(pathToFileURL(join(resolve(traverseRoot), "node_modules/@kontourai/relay/dist/src/index.js")).href);
const { extract, serializePortableExtractionResult, deserializePortableExtractionResult } = traverse;

const outDir = new URL(".", import.meta.url);
const feeSchema = [{ path: "fee", type: "number" }];

/**
 * Proposes every "Fee: <digits>" it can see in the chunk it is handed, grounded
 * in the digits. Throws on the given 1-based calls. Reports a confidence only
 * when `confidence` is a number.
 */
function feeScanner({ failCalls = [], confidence, indexed = false } = {}) {
  let call = 0;
  return {
    name: "fixture-fee-scanner",
    async extract(input) {
      call += 1;
      if (failCalls.includes(call)) throw Object.assign(new Error("503 unavailable"), { status: 503 });
      const proposals = [];
      for (const [index, match] of [...input.content.matchAll(/Fee: (\d+)/g)].entries()) {
        proposals.push({
          fieldPath: indexed ? `plans[${index}].fee` : "fee",
          candidateValue: Number(match[1]),
          ...(typeof confidence === "number" ? { confidence } : {}),
          provenance: { excerpt: match[1], locator: "provisional" },
          extractor: "fixture-fee-scanner",
        });
      }
      return { proposals, raw: { response: "{}", model: "fixture-model", tokensUsed: 5 } };
    },
  };
}

function relayProvider(response) {
  return createRelayExtractionProvider({
    runtime: new FakeModelRuntime([{
      provider: "fixture", model: "fixture-relay-model", outputText: response.outputText ?? "", toolCalls: response.toolCalls ?? [],
      usage: { totalTokens: 3 }, latencyMs: 0, stopReason: response.stopReason,
    }]),
  });
}

// 88 characters: with chunkSize 40 / chunkOverlap 10 that is three chunks,
// [0,40), [30,70), [60,88), each overlapping its neighbour by 10.
const threeChunkText = "Vendor: Acme. Fee: 48000 per year.......Renewal notice: sixty days........Deposit: 52000";

const cases = {
  // Chunk 2's provider call fails: partial/provider-failure, overlapping coverage.
  "partial-provider-failure": () => extract({
    sourceRef: "fixture://vendor-contract", contentType: "text", targetSchema: feeSchema, content: threeChunkText,
    provider: feeScanner({ failCalls: [2], confidence: 0.8 }), chunkSize: 40, chunkOverlap: 10,
  }),
  // Each 40-char chunk is cut to 30 chars at dispatch: partial/content-truncated.
  "partial-content-truncated": () => extract({
    sourceRef: "fixture://vendor-contract", contentType: "text", targetSchema: feeSchema, content: threeChunkText,
    provider: feeScanner({ confidence: 0.8 }), chunkSize: 40, chunkOverlap: 0, maxContentChars: 30,
  }),
  // The answer stops at the output cap: partial/output-truncated.
  "partial-output-truncated": () => extract({
    sourceRef: "fixture://vendor-contract", contentType: "text", targetSchema: feeSchema, content: "Fee: 5.",
    provider: relayProvider({ stopReason: "max_tokens", toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: { proposals: [{ fieldPath: "fee", value: 5, excerpt: "5" }] } }] }),
  }),
  // The provider answers in prose with no tool call: partial/provider-failure, unread/missing-tool-call.
  "partial-missing-tool-call": () => extract({
    sourceRef: "fixture://vendor-contract", contentType: "text", targetSchema: feeSchema, content: "Fee: 5.",
    provider: relayProvider({ stopReason: "end_turn", outputText: "The fee is 5." }),
  }),
  // An early stop (only the first chunk is dispatched) still carries coverage.
  "partial-max-chunks": () => extract({
    sourceRef: "fixture://vendor-contract", contentType: "text", targetSchema: feeSchema, content: threeChunkText,
    provider: feeScanner({ confidence: 0.8 }), chunkSize: 40, chunkOverlap: 10, maxChunks: 1,
  }),
  // Chunk 2's provider answer is not a proposals array: partial/provider-failure
  // with that chunk unread.
  "partial-unusable-answer": () => {
    const scanner = feeScanner({ confidence: 0.8 });
    return extract({
      sourceRef: "fixture://vendor-contract", contentType: "text", targetSchema: feeSchema, content: threeChunkText, chunkSize: 40, chunkOverlap: 10,
      provider: { name: scanner.name, async extract(input) { return input.chunkIndex === 1 ? { proposals: "garbage", raw: { response: "", model: "fixture-model" } } : scanner.extract(input); } },
    });
  },
  // A complete run whose provider reports no confidence.
  "success-no-confidence": () => extract({
    sourceRef: "fixture://vendor-contract", contentType: "text", targetSchema: feeSchema, content: "Vendor: Acme. Fee: 48000 per year.",
    provider: feeScanner({}),
  }),
  // One field, three proposals: 48000 twice at different spans, 52000 once.
  "success-conflicting-fee": () => extract({
    sourceRef: "fixture://vendor-contract", contentType: "text", targetSchema: feeSchema,
    content: "Fee: 48000 per year. Summary Fee: 48000. Amended Fee: 52000.",
    provider: feeScanner({ confidence: 0.9 }),
  }),
  // Markdown prep removes the page header outside <article>, keeps the
  // article's own header and footer, and names what it removed.
  "success-html-page-chrome": () => extract({
    sourceRef: "fixture://vendor-page", contentType: "html", targetSchema: feeSchema, provider: feeScanner({ confidence: 0.7 }),
    content: `<!DOCTYPE html><html><body><header><p>Site banner text</p></header><article><header><h1>Acme renewal</h1><p>Fee: 48000</p></header>`
      + `<p>Terms of the renewal.</p><footer><p>Posted 2026-09-01</p></footer></article></body></html>`,
  }),
  // Structural prep prunes a navigation landmark and names it in a warning.
  // The page lists one fee per plan under an array field, so every proposal
  // carries its own `pathIndices`.
  "success-navigation-pruned": () => extract({
    sourceRef: "fixture://vendor-page", contentType: "html", targetSchema: [{ path: "plans[].fee", type: "number" }],
    provider: feeScanner({ confidence: 0.7, indexed: true }),
    content: `<!DOCTYPE html><html><body><h1>Acme</h1><div role="navigation">Landmark block text</div>`
      + `<ul class="list">${[1, 2, 3, 4].map((i) => `<li class="item"><h3>Plan ${i}</h3><p>Fee: ${i}000</p></li>`).join("")}</ul></body></html>`,
  }),
};

for (const [name, run] of Object.entries(cases)) {
  const result = await run();
  const serialized = serializePortableExtractionResult(result);
  deserializePortableExtractionResult(serialized);
  writeFileSync(new URL(`${name}.v1.json`, outDir), `${JSON.stringify(JSON.parse(serialized), null, 2)}\n`);
  const envelope = JSON.parse(serialized);
  console.log(name, JSON.stringify(envelope.result.outcome), `proposals=${envelope.result.proposals.length}`, `coverage=${envelope.result.coverage?.length ?? 0}`);
}
