import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { copyFile, readFile, mkdtemp, rm } from "node:fs/promises";
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
      // SEP-1865: resources back the ui:// review card + the MCP Apps extension.
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
      assert.deepEqual(decideTool?.inputSchema.properties.decision.enum, [
        "accept", "hold", "reject", "could-not-confirm",
      ]);
      assert.equal(decideTool?.inputSchema.properties.reason.minLength, 1);
      assert.deepEqual(decideTool?.inputSchema.allOf[0].then.required, ["reason"]);
      // survey_review_queue declares its SEP-1865 UI in both key shapes.
      const queueTool = (toolsList.result?.tools ?? []).find(
        (t: { name: string }) => t.name === "survey_review_queue",
      ) as Record<string, any> | undefined;
      assert.equal(queueTool?._meta["ui/resourceUri"], "ui://survey/review-card/queue");
      assert.equal(queueTool?._meta.ui.resourceUri, "ui://survey/review-card/queue");

      // SEP-1865 declared-resource path: list + read the review card.
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
      const contents = ((resourceRead.result as any)?.contents ?? []) as Array<Record<string, string>>;
      assert.equal(contents.length, 1);
      assert.equal(contents[0].uri, "ui://survey/review-card/queue");
      assert.equal(contents[0].mimeType, "text/html;profile=mcp-app");
      assert.match(contents[0].text, /<!doctype html>/i);
      assert.match(contents[0].text, /survey_review_decide/);

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
      assert.match(missingReason.result?.content[0]?.text ?? "", /requires a non-empty reason/);

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
      assert.equal(((noUiResources.result as any)?.resources ?? []).length, 0);
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
