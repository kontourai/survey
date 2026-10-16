import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { assertOwnedServer, runOwnedProbes, startOwnedServer } from "../scripts/playwright-owned-server.mjs";

async function refusesConnections(port) {
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }));
}

function assertExited(pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("actual fixture retains its OS-assigned listener, serves content and refuses another owner's identity", async () => {
  const server = await startOwnedServer();
  try {
    await assertOwnedServer(server.identity);
    const competitor = createServer();
    await assert.rejects(new Promise((resolve, reject) => {
      competitor.once("error", reject);
      competitor.listen(server.identity.port, "127.0.0.1", resolve);
    }), { code: "EADDRINUSE" });
    const response = await fetch(`http://127.0.0.1:${server.identity.port}/examples/review-workbench/index.html`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-survey-playwright-owner"), server.identity.token);
    await assert.rejects(assertOwnedServer({ ...server.identity, pid: server.identity.pid + 1 }), /ownership mismatch/);
  } finally { await server.stop(); }
  assertExited(server.child.pid);
  await refusesConnections(server.identity.port);
});

test("a foreign loopback endpoint cannot substitute for an owned server", async () => {
  const foreign = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ token: "foreign", port: foreign.address().port, pid: process.pid }));
  });
  foreign.listen(0, "127.0.0.1");
  await once(foreign, "listening");
  try {
    await assert.rejects(assertOwnedServer({ port: foreign.address().port, pid: process.pid, token: "00000000-0000-0000-0000-000000000000" }), /ownership mismatch/);
    assert.equal(foreign.listening, true);
  } finally { await new Promise((resolve) => foreign.close(resolve)); }
});

test("a failed probe propagates its failure and joins cleanup of both children and listeners", async () => {
  const events = [];
  const children = [];
  await assert.rejects(runOwnedProbes({
    onEvent: (event) => events.push(event),
    runProbe(identity, index) {
      const child = spawn(process.execPath, ["-e", index === 0 ? "process.exit(17)" : "setInterval(() => {}, 1000)"], {
        windowsHide: true, stdio: "ignore",
      });
      children.push(child);
      const closed = once(child, "close");
      const done = closed.then(([code]) => {
        if (code !== 0) throw new Error(`synthetic probe failure ${code} port ${identity.port}`);
        return { code };
      });
      done.catch(() => {});
      return { child, done, async stop() { child.kill(); await closed; } };
    },
  }), /synthetic probe failure 17/);
  assert.equal(events.filter((e) => e.event === "probe-start").length, 2);
  const servers = events.filter((e) => e.event === "server-bound");
  assert.equal(new Set(servers.map((s) => s.port)).size, 2);
  for (const server of servers) {
    assertExited(server.pid);
    await refusesConnections(server.port);
  }
  for (const child of children) assertExited(child.pid);
  assert.equal(events.at(-1).event, "cleanup-complete");
});

test("fixture follows parent pipe lifetime even without a normal teardown", async () => {
  const server = await startOwnedServer();
  server.child.stdin.end();
  await server.closed;
  await server.stop();
  assertExited(server.child.pid);
  await refusesConnections(server.identity.port);
});

test("fixture spawn failure rejects without an unhandled error or listener", async () => {
  await assert.rejects(startOwnedServer({ cwd: '/nonexistent/survey-owned-fixture' }), /ENOENT/);
});


test("coordinator signal refuses success and joins both owned probes", async () => {
  const events = [];
  await assert.rejects(runOwnedProbes({
    onEvent: (event) => events.push(event),
    runProbe(_identity, index) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
      const closed = once(child, "close");
      if (index === 1) process.emit("SIGTERM");
      return { child, done: new Promise(() => {}), async stop() { child.kill(); await closed; } };
    },
  }), /interrupted: SIGTERM/);
  for (const pid of events.at(-1).children) assertExited(pid);
  for (const event of events.filter((e) => e.event === "server-bound")) await refusesConnections(event.port);
});

test("fixture launch preserves a working directory containing spaces", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "survey owned fixture "));
  let server;
  try {
    await writeFile(join(directory, "index.html"), "owned space-path fixture");
    server = await startOwnedServer({ cwd: directory });
    const response = await fetch(`http://127.0.0.1:${server.identity.port}/index.html`);
    assert.equal(await response.text(), "owned space-path fixture");
  } finally {
    await server?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows teardown kills the owned tree before its leader and joins close", async () => {
  const { stopBrowserProbe } = await import("../scripts/playwright-owned-server.mjs");
  let resolveClose;
  const closed = new Promise((resolve) => { resolveClose = resolve; });
  let descendantAlive = true;
  const calls = [];
  const child = { pid: 4242, exitCode: null, signalCode: null, kill() { assert.fail("leader killed before its tree"); } };
  await stopBrowserProbe(child, closed, { platform: "win32", execFile(file, args, options) {
    calls.push({ file, args, options });
    assert.equal(child.exitCode, null);
    descendantAlive = false;
    child.exitCode = 1;
    resolveClose({ code: 1 });
  } });
  assert.equal(descendantAlive, false);
  assert.deepEqual(calls, [{ file: "taskkill.exe", args: ["/pid", "4242", "/T", "/F"], options: { windowsHide: true, stdio: "ignore", timeout: 5_000 } }]);
});

test("failed Windows tree termination rejects on a bounded close instead of hanging", async () => {
  const { stopBrowserProbe } = await import("../scripts/playwright-owned-server.mjs");
  const signals = [];
  const child = { pid: 4242, exitCode: null, signalCode: null, kill(signal) { signals.push(signal); } };
  await assert.rejects(stopBrowserProbe(child, new Promise(() => {}), {
    platform: "win32", joinMs: 10,
    execFile() { throw new Error("synthetic tree failure"); },
  }), /teardown timed out/);
  assert.deepEqual(signals, ["SIGKILL"]);
});
