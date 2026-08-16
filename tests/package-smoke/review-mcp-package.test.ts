import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("packed Survey CLI serves modern and legacy MCP from a clean consumer", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "survey-mcp-package-"));
  const packDir = join(workspace, "pack");
  const consumer = join(workspace, "consumer");
  const cache = join(workspace, "npm-cache");
  await mkdir(packDir, { recursive: true });
  await mkdir(consumer, { recursive: true });

  try {
    const packed = await execFileAsync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        packDir,
        "--cache",
        cache,
      ],
      { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
    );
    const [entry] = parsePackJson(packed.stdout);
    assert.ok(entry?.filename);

    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module" }, null, 2),
    );
    await execFileAsync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        cache,
        join(packDir, entry.filename),
      ],
      { cwd: consumer, maxBuffer: 10 * 1024 * 1024 },
    );

    const packageRoot = join(
      consumer,
      "node_modules",
      "@kontourai",
      "survey",
    );
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    assert.equal(
      manifest.dependencies?.["@modelcontextprotocol/server"],
      "2.0.0",
    );
    assert.equal(manifest.dependencies?.zod, "4.4.3");

    const cli = join(consumer, "node_modules", ".bin", "survey-review-mcp");
    const fixture = join(packageRoot, "example-data", "mcp-review-session.json");
    await exerciseInstalledServer(cli, fixture, consumer, "modern");
    await exerciseInstalledServer(cli, fixture, consumer, "legacy");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function exerciseInstalledServer(
  cli: string,
  fixture: string,
  cwd: string,
  era: "modern" | "legacy",
): Promise<void> {
  const server = spawn(cli, ["--session", fixture], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = collectResponses(server.stdout!);

  try {
    if (era === "modern") {
      send(server, {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: modernMeta() },
      });
      const discovery = await responses.next(1);
      assert.deepEqual(discovery.result?.supportedVersions, ["2026-07-28"]);
      assert.equal(discovery.result?.resultType, "complete");
    } else {
      send(server, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "survey-package-smoke", version: "0.0.0" },
        },
      });
      const initialization = await responses.next(1);
      assert.equal(initialization.result?.protocolVersion, "2025-06-18");
      send(server, { jsonrpc: "2.0", method: "notifications/initialized" });
    }

    send(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        ...(era === "modern" ? { _meta: modernMeta() } : {}),
        name: "survey_review_queue",
        arguments: {},
      },
    });
    const queue = await responses.next(2);
    assert.equal(queue.result?.isError, false);
    assert.match(queue.result?.content?.[0]?.text ?? "", /Review queue/);

    send(server, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: {
        ...(era === "modern" ? { _meta: modernMeta() } : {}),
        uri: "ui://survey/review-card/queue",
      },
    });
    const resource = await responses.next(3);
    assert.equal(
      resource.result?.contents?.[0]?.mimeType,
      "text/html;profile=mcp-app",
    );
  } finally {
    server.stdin!.end();
    await once(server, "exit");
  }
}

function parsePackJson(output: string): Array<{ filename: string }> {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) {
    throw new Error(`npm pack did not emit JSON: ${output}`);
  }
  return JSON.parse(output.slice(start, end + 1)) as Array<{ filename: string }>;
}

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    },
    "io.modelcontextprotocol/clientInfo": {
      name: "survey-package-smoke",
      version: "0.0.0",
    },
  };
}

function send(server: ReturnType<typeof spawn>, message: unknown): void {
  server.stdin!.write(`${JSON.stringify(message)}\n`);
}

interface Response {
  id?: number;
  result?: Record<string, any>;
}

function collectResponses(stdout: NodeJS.ReadableStream) {
  const queued = new Map<number, Response>();
  const waiters = new Map<number, (response: Response) => void>();
  const lines = createInterface({ input: stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const response = JSON.parse(line) as Response;
    if (typeof response.id !== "number") return;
    const waiter = waiters.get(response.id);
    if (waiter) {
      waiters.delete(response.id);
      waiter(response);
    } else {
      queued.set(response.id, response);
    }
  });

  return {
    next(id: number): Promise<Response> {
      const existing = queued.get(id);
      if (existing) {
        queued.delete(id);
        return Promise.resolve(existing);
      }
      return new Promise((resolveResponse, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for MCP response ${id}`)),
          15_000,
        );
        waiters.set(id, (response) => {
          clearTimeout(timeout);
          resolveResponse(response);
        });
      });
    },
  };
}
