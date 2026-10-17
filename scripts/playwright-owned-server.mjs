import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const playwrightCli = require.resolve("@playwright/test/cli");
export const ownerPath = "/__survey_playwright_owner";

export async function assertOwnedServer(identity) {
  if (!identity || !Number.isInteger(identity.port) || identity.port < 1024 || identity.port > 65535
      || !Number.isInteger(identity.pid) || identity.pid <= 0
      || typeof identity.token !== "string" || !/^[\da-f-]{36}$/.test(identity.token)) {
    throw new Error("Invalid Survey Playwright server ownership identity");
  }
  const response = await fetch(`http://127.0.0.1:${identity.port}${ownerPath}`, {
    signal: AbortSignal.timeout(5_000), redirect: "error",
  });
  const actual = await response.json();
  if (!response.ok || actual.port !== identity.port || actual.pid !== identity.pid || actual.token !== identity.token) {
    throw new Error("Survey Playwright server ownership mismatch");
  }
}

export async function startOwnedServer({ cwd = process.cwd() } = {}) {
  const token = randomUUID();
  const child = spawn("python3", ["-u", fileURLToPath(new URL("./playwright-owned-server.py", import.meta.url)), token], {
    cwd, windowsHide: true, stdio: ["pipe", "pipe", "inherit"],
  });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  // Attach before reading readiness so spawn failures cannot escape cleanup.
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  const stop = async () => {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try { await boundedClose(closed, 5_000); }
    catch (error) {
      child.kill("SIGKILL");
      await boundedClose(closed, 5_000);
    }
  };
  try {
    const identity = await new Promise((resolve, reject) => {
      let data = "";
      const timer = setTimeout(() => finish(new Error("Survey fixture readiness timed out")), 10_000);
      const onData = (chunk) => {
        data += chunk;
        if (data.length > 4096) return finish(new Error("Oversized Survey fixture readiness"));
        if (data.includes("\n")) {
          try { finish(null, JSON.parse(data.split("\n")[0])); } catch (error) { finish(error); }
        }
      };
      const onClose = () => finish(spawnError ?? new Error("Survey fixture exited before readiness"));
      const finish = (error, value) => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("close", onClose);
        error ? reject(error) : resolve(value);
      };
      child.stdout.on("data", onData);
      child.once("close", onClose);
    });
    if (identity.token !== token || identity.pid !== child.pid) throw new Error("Survey fixture child identity mismatch");
    await assertOwnedServer(identity);
    return { identity, child, closed, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function runOwnedProbes({ runProbe, onEvent = (event) => console.log(JSON.stringify(event)) } = {}) {
  const servers = [];
  const probes = [];
  let interrupted;
  const aborted = new Promise((_, reject) => { interrupted = reject; });
  const onInterrupt = (signal) => interrupted(new Error(`Survey concurrency coordinator interrupted: ${signal}`));
  const onSigint = () => onInterrupt("SIGINT");
  const onSigterm = () => onInterrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const deadline = setTimeout(() => onInterrupt("120s deadline"), 120_000);
  // A signal during startup must not become an unhandled rejection.
  aborted.catch(() => {});
  let failure;
  try {
    // Both sockets are already owned before either actual Playwright probe starts.
    for (let index = 0; index < 2; index++) servers.push(await startOwnedServer());
    for (const [index, server] of servers.entries()) {
      onEvent({ at: new Date().toISOString(), event: "server-bound", index, ...server.identity });
      const probe = runProbe ? runProbe(server.identity, index) : startBrowserProbe(server.identity, index);
      probes.push(probe);
      onEvent({ at: new Date().toISOString(), event: "probe-start", index, pid: probe.child.pid, port: server.identity.port });
    }
    await Promise.race([aborted, Promise.all(probes.map(async (probe, index) => {
      const result = await Promise.race([
        probe.done,
        servers[index].closed.then(({ code, signal }) => { throw new Error(`Owned Survey server exited during probe ${index}: ${signal ?? code}`); }),
      ]);
      onEvent({ at: new Date().toISOString(), event: "probe-complete", index, port: servers[index].identity.port, ...result });
    }))]);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(deadline);
    const cleanup = await Promise.allSettled([
      ...probes.map((probe) => probe.stop()),
      ...servers.map((server) => server.stop()),
    ]);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    const errors = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "Survey probe/cleanup failure");
    onEvent({ at: new Date().toISOString(), event: "cleanup-complete", children: [...probes.map((p) => p.child.pid), ...servers.map((s) => s.child.pid)] });
  }
  if (failure) throw failure;
}

export function startBrowserProbe(identity, index) {
  const child = spawn(process.execPath, [
    playwrightCli, "test", "tests/browser/review-workbench.spec.ts", "--grep", "renders field-diff cards",
    `--output=test-results/concurrent-${index}`, "--reporter=list", "--retries=0",
  ], {
    windowsHide: true,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      SURVEY_PLAYWRIGHT_PORT: String(identity.port),
      SURVEY_PLAYWRIGHT_OWNER: JSON.stringify(identity),
      SURVEY_PLAYWRIGHT_SKIP_BUILD: "1",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const outcomes = new Set();
  let output = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    output += chunk;
    const lines = output.split("\n");
    output = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("{\"event\":\"browser-owned-response\"")) continue;
      const event = JSON.parse(line);
      if (event.port === identity.port && event.serverPid === identity.pid) outcomes.add(event.project);
    }
  });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    closed.then(({ code, signal }) => {
      if (code !== 0) return reject(new Error(`Playwright concurrency probe on port ${identity.port} exited with ${signal ?? code}`));
      if (!outcomes.has("chromium-desktop") || !outcomes.has("chromium-mobile")) {
        return reject(new Error(`Missing owned browser outcomes on port ${identity.port}`));
      }
      resolve({ code, signal, projects: [...outcomes] });
    });
  });
  // The other probe can fail before this promise is awaited.
  done.catch(() => {});
  return {
    child, done,
    stop: () => stopBrowserProbe(child, closed),
  };
}

// The injected platform/process functions are narrow seams for Windows ordering
// controls on POSIX. They do not replace the actual browser-probe validation.
export async function stopBrowserProbe(child, closed, {
  platform = process.platform,
  execFile = execFileSync,
  kill = process.kill.bind(process),
  graceMs = 10_000,
  joinMs = 5_000,
} = {}) {
  const live = () => child.exitCode === null && child.signalCode === null;
  const killGroup = () => {
    if (!child.pid) return;
    try { kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  if (platform === "win32") {
    let treeError;
    if (live()) {
      // Windows child.kill(SIGINT) kills the leader immediately. Terminate its
      // tree first, while taskkill can still discover the owned descendants.
      try {
        execFile("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true, stdio: "ignore", timeout: joinMs,
        });
      } catch (error) {
        treeError = error;
        if (live()) child.kill("SIGKILL");
      }
    }
    await boundedClose(closed, joinMs);
    if (treeError) throw treeError;
  } else {
    if (live()) child.kill("SIGINT");
    try {
      await boundedClose(closed, graceMs);
    } catch (error) {
      killGroup();
      await boundedClose(closed, joinMs);
    } finally {
      // Also remove a surviving worker after a leader that already exited.
      killGroup();
    }
  }
}

async function boundedClose(closed, milliseconds) {
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Survey probe teardown timed out")), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
