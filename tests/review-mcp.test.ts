import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { copyFile, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string | null;
  result?: {
    content: Array<{ type: string; text?: string; resource?: Record<string, unknown> }>;
    isError: boolean;
    tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    protocolVersion?: string;
    serverInfo?: { name: string };
    capabilities?: Record<string, unknown>;
  } & Record<string, unknown>;
  error?: { code: number; message: string };
}

const MODERN_PROTOCOL_VERSION = "2026-07-28";

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    },
    "io.modelcontextprotocol/clientInfo": {
      name: "survey-review-mcp-tests",
      version: "0.0.0",
    },
  };
}

function send(server: ReturnType<typeof spawn>, message: unknown): void {
  server.stdin!.write(`${JSON.stringify(message)}\n`);
}

function collectResponses(stdout: NodeJS.ReadableStream) {
  const byId = new Map<number, JsonRpcResponse>();
  const waiters = new Map<number, (response: JsonRpcResponse) => void>();
  const rl = createInterface({ input: stdout });
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    const parsed = JSON.parse(line) as JsonRpcResponse;
    if (typeof parsed.id !== "number") return;
    const waiter = waiters.get(parsed.id);
    if (waiter) {
      waiters.delete(parsed.id);
      waiter(parsed);
    } else {
      byId.set(parsed.id, parsed);
    }
  });

  return {
    next(id: number): Promise<JsonRpcResponse> {
      const existing = byId.get(id);
      if (existing) {
        byId.delete(id);
        return Promise.resolve(existing);
      }
      return new Promise((resolveResponse, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for response ${id}`)),
          15_000,
        );
        waiters.set(id, (response) => {
          clearTimeout(timer);
          resolveResponse(response);
        });
      });
    },
  };
}

describe("survey-review-mcp", () => {
  test("serves MCP 2026-07-28 discovery, review tools, and resource envelopes", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-modern-test-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);
    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const responses = collectResponses(server.stdout!);

    try {
      send(server, {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: modernMeta() },
      });
      const discover = await responses.next(1);
      assert.deepEqual(discover.result?.supportedVersions, [MODERN_PROTOCOL_VERSION]);
      assert.equal(discover.result?.resultType, "complete");
      assert.equal(discover.result?.ttlMs, 0);
      assert.equal(discover.result?.cacheScope, "private");
      assert.ok(discover.result?.capabilities?.tools);
      assert.ok(discover.result?.capabilities?.resources);
      assert.ok(
        (
          discover.result?.capabilities?.extensions as Record<string, unknown>
        )?.["io.modelcontextprotocol/ui"],
      );
      assert.equal(
        (
          discover.result?._meta as Record<
            string,
            { name?: string }
          >
        )?.["io.modelcontextprotocol/serverInfo"]?.name,
        "survey-review-mcp",
      );

      send(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: { _meta: modernMeta() },
      });
      const tools = await responses.next(2);
      assert.equal(tools.result?.resultType, "complete");
      assert.equal(tools.result?.ttlMs, 0);
      assert.equal(tools.result?.cacheScope, "private");
      const queueTool = (tools.result?.tools ?? []).find(
        (tool: { name: string }) => tool.name === "survey_review_queue",
      ) as Record<string, any> | undefined;
      const decideTool = (tools.result?.tools ?? []).find(
        (tool: { name: string }) => tool.name === "survey_review_decide",
      ) as Record<string, any> | undefined;
      assert.equal(queueTool?._meta.ui.resourceUri, "ui://survey/review-card/queue");
      assert.equal(queueTool?._meta["ui/resourceUri"], "ui://survey/review-card/queue");
      const decideBranches =
        decideTool?.inputSchema?.oneOf ?? decideTool?.inputSchema?.anyOf ?? [];
      const couldNotConfirmBranch = decideBranches.find(
        (branch: Record<string, any>) =>
          branch.properties?.decision?.const === "could-not-confirm",
      );
      assert.deepEqual(
        couldNotConfirmBranch?.required,
        ["itemName", "decision", "reason"],
      );

      send(server, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          _meta: modernMeta(),
          name: "survey_review_queue",
          arguments: {},
        },
      });
      const queue = await responses.next(3);
      assert.equal(queue.result?.resultType, "complete");
      assert.equal(queue.result?.isError, false);
      assert.match(queue.result?.content[0]?.text ?? "", /Review queue/);

      send(server, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          _meta: modernMeta(),
          name: "survey_review_decide",
          arguments: {
            itemName: "public-directory-hours",
            decision: "accept",
            note: "Modern client reviewed the proposal.",
          },
        },
      });
      const decision = await responses.next(4);
      assert.equal(decision.result?.resultType, "complete");
      assert.equal(decision.result?.isError, false);
      assert.match(decision.result?.content[0]?.text ?? "", /Decision recorded/);

      send(server, {
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: {
          _meta: modernMeta(),
          uri: "ui://survey/review-card/queue",
        },
      });
      const resource = await responses.next(5);
      assert.equal(resource.result?.resultType, "complete");
      assert.equal(resource.result?.ttlMs, 0);
      assert.equal(resource.result?.cacheScope, "private");
      const contents = resource.result?.contents as Array<Record<string, any>>;
      assert.equal(contents[0]?.mimeType, "text/html;profile=mcp-app");
      assert.deepEqual(contents[0]?._meta.ui.csp, {
        connectDomains: [],
        resourceDomains: [],
      });

      const persisted = JSON.parse(await readFile(sessionPath, "utf8")) as {
        events: Array<{ spec?: { data?: { workbenchDecision?: string } } }>;
      };
      assert.ok(
        persisted.events.some(
          (event) => event.spec?.data?.workbenchDecision === "accept-proposed",
        ),
      );
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("initialize and tools/list complete the MCP handshake", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-test-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile(
      "example-data/mcp-review-session.json",
      sessionPath,
    );

    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const responses = collectResponses(server.stdout!);

    try {
      send(server, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "review-mcp-tests", version: "0.0.0" },
        },
      });
      const initialize = await responses.next(1);
      assert.equal(initialize.result?.serverInfo?.name, "survey-review-mcp");
      assert.equal(initialize.result?.protocolVersion, "2025-06-18");
      assert.ok(initialize.result?.capabilities?.tools);
      // Resources back the ui:// review card plus the MCP Apps extension.
      assert.ok((initialize.result?.capabilities as Record<string, unknown>)?.resources);
      assert.ok(
        (
          (initialize.result?.capabilities as Record<string, Record<string, unknown>>)
            ?.extensions as Record<string, unknown>
        )?.["io.modelcontextprotocol/ui"],
      );

      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });

      send(server, { jsonrpc: "2.0", id: 2, method: "ping" });
      const ping = await responses.next(2);
      assert.deepEqual(ping.result, {});

      send(server, { jsonrpc: "2.0", id: 3, method: "tools/list" });
      const toolsList = await responses.next(3);
      const toolNames = (toolsList.result?.tools ?? []).map((t: { name: string }) => t.name).sort();
      assert.deepEqual(toolNames, [
        "survey_review_decide",
        "survey_review_item",
        "survey_review_queue",
      ]);
      for (const tool of toolsList.result?.tools ?? []) {
        assert.equal(typeof tool.description, "string");
        assert.equal(tool.inputSchema.type, "object");
      }
      const decideTool = (toolsList.result?.tools ?? []).find(
        (t: { name: string }) => t.name === "survey_review_decide",
      ) as Record<string, any> | undefined;
      const decisionBranches = decideTool?.inputSchema.oneOf ?? [];
      assert.deepEqual(
        decisionBranches[0]?.properties.decision.enum,
        ["accept", "hold", "reject"],
      );
      assert.equal(
        decisionBranches[1]?.properties.decision.const,
        "could-not-confirm",
      );
      assert.match(
        decisionBranches[1]?.properties.reason.description,
        /Required non-empty reason/,
      );
      assert.deepEqual(
        decisionBranches[1]?.required,
        ["itemName", "decision", "reason"],
      );
      // The queue declares canonical nested UI metadata plus flat compatibility.
      const queueTool = (toolsList.result?.tools ?? []).find(
        (t: { name: string }) => t.name === "survey_review_queue",
      ) as Record<string, any> | undefined;
      assert.equal(queueTool?._meta["ui/resourceUri"], "ui://survey/review-card/queue");
      assert.equal(queueTool?._meta.ui.resourceUri, "ui://survey/review-card/queue");

      // Declared-resource path: list and read the review card.
      send(server, { jsonrpc: "2.0", id: 4, method: "resources/list" });
      const resourcesList = await responses.next(4);
      const listed = ((resourcesList.result as any)?.resources ?? []) as Array<Record<string, unknown>>;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].uri, "ui://survey/review-card/queue");
      assert.equal(listed[0].mimeType, "text/html;profile=mcp-app");

      send(server, {
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: "ui://survey/review-card/queue" },
      });
      const resourceRead = await responses.next(5);
      const contents = ((resourceRead.result as any)?.contents ?? []) as Array<Record<string, any>>;
      assert.equal(contents.length, 1);
      assert.equal(contents[0].uri, "ui://survey/review-card/queue");
      assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
      assert.match(contents[0].text, /<!doctype html>/i);
      assert.match(contents[0].text, /survey_review_decide/);
      assert.deepEqual(contents[0]._meta.ui.csp, {
        connectDomains: [],
        resourceDomains: [],
      });

      send(server, {
        jsonrpc: "2.0",
        id: 6,
        method: "resources/read",
        params: { uri: "ui://survey/does-not-exist" },
      });
      const unknownResource = await responses.next(6);
      assert.equal(unknownResource.error?.code, -32602);
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("survey_review_queue returns text + UI resource", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-test-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);

    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const responses = collectResponses(server.stdout!);

    try {
      send(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      await responses.next(1);
      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });

      send(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "survey_review_queue", arguments: {} } });
      const queueResult = await responses.next(2);

      assert.equal(queueResult.result?.isError, false);

      // Content has at least 2 items: text and resource
      const content = queueResult.result?.content ?? [];
      assert.ok(content.length >= 2, `Expected at least 2 content items, got ${content.length}`);

      const textItem = content.find((c) => c.type === "text");
      assert.ok(textItem, "Expected a text content item");
      assert.match(textItem.text ?? "", /Review queue/);
      assert.match(textItem.text ?? "", /pending|resolved|in-review/);

      const resourceItem = content.find((c) => c.type === "resource");
      assert.ok(resourceItem, "Expected a resource content item");
      const resource = resourceItem.resource as Record<string, unknown>;
      assert.ok((resource.uri as string).startsWith("ui://survey/review-card/"), "Expected UI resource URI");
      assert.equal(resource.mimeType, "text/html;profile=mcp-app");
      const html = resource.text as string;
      assert.match(html, /<!doctype html>/i);
      assert.match(html, /survey_review_decide/);
      assert.match(html, /Accept proposed/);
      assert.ok(typeof (resource._meta as Record<string, unknown>)["mcpui.dev/ui-preferred-frame-size"] !== "undefined");
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("survey_review_item returns full item detail + UI resource", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-test-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);

    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const responses = collectResponses(server.stdout!);

    try {
      send(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      await responses.next(1);
      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });

      send(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "survey_review_item", arguments: { itemName: "public-directory-hours" } },
      });
      const itemResult = await responses.next(2);

      assert.equal(itemResult.result?.isError, false);
      const content = itemResult.result?.content ?? [];
      const textItem = content.find((c) => c.type === "text");
      assert.ok(textItem, "Expected text content");
      assert.match(textItem.text ?? "", /hours/);
      assert.match(textItem.text ?? "", /Current value/);
      assert.match(textItem.text ?? "", /Proposed value/);
      assert.match(textItem.text ?? "", /confidence/);

      const resourceItem = content.find((c) => c.type === "resource");
      assert.ok(resourceItem, "Expected resource content");
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("survey_review_decide round-trip mutates the session file and subsequent queue call reflects it", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-test-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);

    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const responses = collectResponses(server.stdout!);

    try {
      send(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      await responses.next(1);
      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });

      // Apply a decision
      send(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "survey_review_decide",
          arguments: { itemName: "public-directory-hours", decision: "accept", note: "Looks correct." },
        },
      });
      const decideResult = await responses.next(2);
      assert.equal(decideResult.result?.isError, false);
      const decideText = (decideResult.result?.content?.[0] as { text?: string })?.text ?? "";
      assert.match(decideText, /Accept proposed/);
      assert.match(decideText, /Updated queue/);

      // Read the file directly to verify it was mutated
      const raw = await readFile(sessionPath, "utf8");
      const parsed = JSON.parse(raw) as { events: Array<{ spec: { data?: { workbenchDecision?: string } } }> };
      const hasDecisionEvent = parsed.events.some(
        (e) => e.spec?.data?.workbenchDecision === "accept-proposed",
      );
      assert.ok(hasDecisionEvent, "Session file should contain accept-proposed decision event");

      // Subsequent queue call reflects the decision
      send(server, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "survey_review_queue", arguments: {} } });
      const queueResult = await responses.next(3);
      assert.equal(queueResult.result?.isError, false);
      const queueText = (queueResult.result?.content?.[0] as { text?: string })?.text ?? "";
      assert.match(queueText, /accepted=1|resolved/);
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("survey_review_decide records could-not-confirm only with a required reason", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-test-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);
    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const responses = collectResponses(server.stdout!);

    try {
      send(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      await responses.next(1);
      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });

      send(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "survey_review_decide", arguments: { itemName: "public-directory-hours", decision: "could-not-confirm" } },
      });
      const missingReason = await responses.next(2);
      assert.equal(missingReason.result?.isError, true);
      assert.match(
        missingReason.result?.content[0]?.text ?? "",
        /reason: Invalid input/,
      );

      send(server, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "survey_review_decide",
          arguments: {
            itemName: "public-directory-hours",
            decision: "could-not-confirm",
            reason: "The listed hours could not be matched to an effective date.",
            attemptEvidenceIds: ["evidence.hours.page", "evidence.hours.archive"],
          },
        },
      });
      const result = await responses.next(3);
      assert.equal(result.result?.isError, false);
      assert.match(result.result?.content[0]?.text ?? "", /Could not confirm/);

      const parsed = JSON.parse(await readFile(sessionPath, "utf8")) as {
        events: Array<{ spec: Record<string, any> }>;
      };
      const event = parsed.events.find((entry) => entry.spec.data?.workbenchDecision === "could-not-confirm");
      assert.equal(event?.spec.status, "proposed");
      assert.equal(event?.spec.resolution, "could_not_confirm");
      assert.equal(event?.spec.resolutionReason, "The listed hours could not be matched to an effective date.");
      assert.deepEqual(event?.spec.attemptEvidenceIds, ["evidence.hours.page", "evidence.hours.archive"]);

      send(server, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "survey_review_decide",
          arguments: {
            itemName: "public-directory-hours",
            decision: "approve",
          },
        },
      });
      const invalidDecision = await responses.next(4);
      assert.equal(invalidDecision.result?.isError, true);
      assert.match(
        invalidDecision.result?.content[0]?.text ?? "",
        /Input validation error: Invalid arguments/,
      );
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("survey_review_decide returns isError:true for unknown item", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-test-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);

    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const responses = collectResponses(server.stdout!);

    try {
      send(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      await responses.next(1);
      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });

      send(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "survey_review_decide", arguments: { itemName: "no-such-item", decision: "accept" } },
      });
      const result = await responses.next(2);
      assert.equal(result.result?.isError, true);
      const text = (result.result?.content?.[0] as { text?: string })?.text ?? "";
      assert.match(text, /Unknown review item/);
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("survey_review_item returns isError:true for unknown item", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-test-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);

    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const responses = collectResponses(server.stdout!);

    try {
      send(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      await responses.next(1);
      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });

      send(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "survey_review_item", arguments: { itemName: "does-not-exist" } },
      });
      const result = await responses.next(2);
      assert.equal(result.result?.isError, true);
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("--no-ui flag suppresses UI resource from queue and item results", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-test-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);

    const server = spawn(
      "node",
      ["bin/survey-review-mcp.mjs", "--session", sessionPath, "--no-ui"],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const responses = collectResponses(server.stdout!);

    try {
      send(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      const noUiInitialize = await responses.next(1);
      // --no-ui suppresses the resources capability and the MCP Apps extension.
      assert.equal((noUiInitialize.result?.capabilities as Record<string, unknown>)?.resources, undefined);
      assert.equal((noUiInitialize.result?.capabilities as Record<string, unknown>)?.extensions, undefined);
      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });

      // No UI resources are advertised, and survey_review_queue carries no _meta.
      send(server, { jsonrpc: "2.0", id: 10, method: "resources/list" });
      const noUiResources = await responses.next(10);
      assert.equal(noUiResources.error?.code, -32601);
      send(server, { jsonrpc: "2.0", id: 11, method: "tools/list" });
      const noUiTools = await responses.next(11);
      const noUiQueue = (noUiTools.result?.tools ?? []).find(
        (t: { name: string }) => t.name === "survey_review_queue",
      ) as Record<string, any> | undefined;
      assert.equal(noUiQueue?._meta, undefined);

      send(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "survey_review_queue", arguments: {} } });
      const queueResult = await responses.next(2);
      assert.equal(queueResult.result?.isError, false);
      const content = queueResult.result?.content ?? [];
      const hasResource = content.some((c) => c.type === "resource");
      assert.equal(hasResource, false, "--no-ui should suppress resource items");

      // Text item must still be present
      assert.ok(content.some((c) => c.type === "text"), "Text item should still be present");
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("successful tool output strips terminal and bidi controls from producer text", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-test-"));
    const sessionPath = join(tmpDir, "session.json");
    const fixture = JSON.parse(
      await readFile("example-data/mcp-review-session.json", "utf8"),
    ) as Record<string, any>;
    fixture.snapshot.items[0].spec.target = "safe\u001b[31m target\u202e";
    fixture.snapshot.items[0].spec.candidates[0].value = "current\u0007 value";
    await writeFile(sessionPath, JSON.stringify(fixture, null, 2));

    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const responses = collectResponses(server.stdout!);

    try {
      send(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      await responses.next(1);
      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });

      send(server, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "survey_review_item",
          arguments: { itemName: fixture.snapshot.items[0].metadata.name },
        },
      });
      const result = await responses.next(2);
      assert.equal(result.result?.isError, false);
      const text = result.result?.content?.[0]?.text ?? "";
      assert.match(text, /safe\[31m target/);
      assert.match(text, /current value/);
      assert.doesNotMatch(
        text,
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u0080-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/,
      );
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("unknown method returns -32601 error", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "survey-mcp-test-"));
    const sessionPath = join(tmpDir, "session.json");
    await copyFile("example-data/mcp-review-session.json", sessionPath);

    const server = spawn("node", ["bin/survey-review-mcp.mjs", "--session", sessionPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const responses = collectResponses(server.stdout!);

    try {
      send(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      await responses.next(1);

      send(server, { jsonrpc: "2.0", id: 2, method: "no/such/method" });
      const unknownMethod = await responses.next(2);
      assert.equal(unknownMethod.error?.code, -32601);
    } finally {
      server.stdin!.end();
      await once(server, "exit");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
