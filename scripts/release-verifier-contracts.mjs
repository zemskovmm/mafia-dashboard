/* global URL */
import { parseVerifierAuthCookie, parseVerifierClubId } from "./session-verifier-contracts.mjs";

export const RELEASE_GATES = Object.freeze(
  ["check", "compose", "backup", "ui", "ui-hardening", "session", "oauth"].map((name) =>
    Object.freeze({
      name,
      command: "npm",
      args: ["run", name === "check" ? "check" : `verify:${name}`],
    }),
  ),
);

export const assertNoReleaseArguments = (args) => {
  if (args.length !== 0) throw new Error("verify:release does not accept arguments");
};

const required = (environment, key) => {
  const value = environment[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value.trim();
};

export const assertReleaseEnvironment = (environment) => {
  const appUrl = required(environment, "APP_URL");
  const parsedUrl = new URL(appUrl);
  if (parsedUrl.protocol !== "https:") throw new Error("APP_URL must use HTTPS");
  if (
    parsedUrl.origin !== appUrl ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== ""
  ) {
    throw new Error("APP_URL must be an exact credential-free origin");
  }
  const commit = required(environment, "RELEASE_COMMIT");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("RELEASE_COMMIT must be a full Git SHA");
  const expectedOrigin = required(environment, "SESSION_VERIFY_EXPECTED_ORIGIN");
  if (expectedOrigin !== parsedUrl.origin) {
    throw new Error("SESSION_VERIFY_EXPECTED_ORIGIN must exactly match APP_URL origin");
  }
  if (required(environment, "SESSION_VERIFY_ALLOW_REMOTE") !== "1") {
    throw new Error("SESSION_VERIFY_ALLOW_REMOTE must equal 1");
  }
  parseVerifierAuthCookie(required(environment, "SESSION_AUTH_COOKIE"), { required: true });
  parseVerifierClubId(required(environment, "SESSION_CLUB_ID"));
  return { appUrl, commit, expectedOrigin };
};

export const assertReleaseCandidate = ({
  packageVersion,
  head,
  releaseCommit,
  trackedStatus,
  deployedIdentity,
}) => {
  if (packageVersion !== "1.0.0") throw new Error("Release package version must be 1.0.0");
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("HEAD must be a full Git SHA");
  if (head !== releaseCommit) throw new Error("RELEASE_COMMIT does not match HEAD");
  if (trackedStatus.trim() !== "") throw new Error("Tracked files must be clean");
  if (deployedIdentity?.version !== packageVersion || deployedIdentity?.commit !== releaseCommit) {
    throw new Error("Deployed release identity does not match the local candidate");
  }
};

export const redactDiagnostic = (value, secrets = [], limit = 64 * 1024) => {
  let output = String(value);
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    output = output.replaceAll(secret, "[redacted]");
  }
  output = output
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:cookie|token|secret|password)[^=:\s]*\s*[=:]\s*)[^\s]+/gi, "$1[redacted]");
  return output.length <= limit ? output : `${output.slice(0, limit)}\n[truncated]`;
};

export const runGateMatrix = async ({ gates = RELEASE_GATES, runCommand, now = Date.now }) => {
  const results = [];
  for (const gate of gates) {
    const startedAt = now();
    let outcome;
    try {
      outcome = await runCommand(gate);
    } catch (error) {
      outcome = { error, status: null, signal: null, stdout: "", stderr: "" };
    }
    const passed = outcome.error == null && outcome.signal == null && outcome.status === 0;
    const result = {
      name: gate.name,
      status: passed ? "PASS" : "FAIL",
      durationMs: Math.max(0, now() - startedAt),
    };
    results.push(result);
    if (!passed) {
      const error = new Error(`Release gate failed: ${gate.name}`);
      error.gate = gate.name;
      error.outcome = outcome;
      error.results = results;
      throw error;
    }
  }
  return results;
};
