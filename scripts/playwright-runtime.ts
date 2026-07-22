const LOCAL_PORT_BASE = 20_000;
const LOCAL_PORT_SPAN = 20_000;
const CI_PORT = 4_180;

export interface PlaywrightRuntime {
  baseURL: string;
  buildCommand: string;
  port: number;
}

export function resolvePlaywrightRuntime(
  environment: NodeJS.ProcessEnv,
  processId: number,
): PlaywrightRuntime {
  const configuredPort = environment.SURVEY_PLAYWRIGHT_PORT;
  const port = configuredPort === undefined
    ? environment.CI
      ? CI_PORT
      : LOCAL_PORT_BASE + (processId % LOCAL_PORT_SPAN)
    : parsePort(configuredPort);

  return {
    baseURL: `http://127.0.0.1:${port}`,
    buildCommand: environment.SURVEY_PLAYWRIGHT_SKIP_BUILD === "1" ? "" : "npm run build && ",
    port,
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("SURVEY_PLAYWRIGHT_PORT must be an integer from 1024 through 65535");
  }
  return port;
}
