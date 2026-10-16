// Pure helpers for scripts/test-local.mjs, kept apart so tests can import them.

export function pinnedBase(dockerfile) {
  const from = dockerfile.split("\n").find(line => line.startsWith("FROM "));
  const match = from?.match(/plow-cloud-agents:base-([0-9a-f]{40})@sha256:[0-9a-f]{64}\s*$/);
  if (!match) throw new Error("The Dockerfile must pin the base as plow-cloud-agents:base-<sha>@sha256:<digest>");
  return match[1];
}

// ENV lines as Docker reads them: KEY=value or KEY="value with spaces".
export function dockerEnv(dockerfile) {
  const env = {};
  for (const line of dockerfile.split("\n").filter(line => line.startsWith("ENV "))) {
    for (const [, key, quoted, bare] of line.slice(4).matchAll(/([A-Z_][A-Z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g)) {
      env[key] = quoted ?? bare;
    }
  }
  return env;
}
