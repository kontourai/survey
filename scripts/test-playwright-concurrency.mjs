import { spawn } from "node:child_process";

const portBase = 40_000 + (process.pid % 10_000) * 2;
const ports = [portBase, portBase + 1];

if (ports[1] > 65_535) {
  throw new Error(`Unable to allocate concurrency-test ports from process ${process.pid}`);
}

await Promise.all(ports.map((port) => runBrowserProbe(port)));

function runBrowserProbe(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["playwright", "test", "tests/browser/review-workbench.spec.ts", "--grep", "renders field-diff cards"],
      {
        env: {
          ...process.env,
          SURVEY_PLAYWRIGHT_PORT: String(port),
          SURVEY_PLAYWRIGHT_SKIP_BUILD: "1",
        },
        stdio: "inherit",
      },
    );

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Playwright concurrency probe on port ${port} exited with ${signal ?? code}`));
    });
  });
}
