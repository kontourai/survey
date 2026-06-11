#!/usr/bin/env node
import { runReviewMcp } from "../dist/src/mcp/review-mcp.js";

runReviewMcp(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
