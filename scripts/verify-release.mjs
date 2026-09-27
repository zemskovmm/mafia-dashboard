/* global AbortSignal, URL, fetch */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RELEASE_GATES,
  assertNoReleaseArguments,
  assertReleaseCandidate,
  assertReleaseEnvironment,
  composeAppVersion,
  redactDiagnostic,
  runGateMatrix,
} from "./release-verifier-contracts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runGit = (args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
};
const secrets = [process.env.SESSION_AUTH_COOKIE];
let release;
let appVersion = "unknown";
let head = "unknown";
let trackedStatus = "";
let deployedIdentity = null;
const verifyDeploymentIdentity = async () => {
  trackedStatus = runGit(["status", "--porcelain", "--untracked-files=no"]);
  const response = await fetch(new URL("/health/version", release.appUrl), {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Deployed release identity failed with HTTP ${response.status}`);
  }
  deployedIdentity = await response.json();
  assertReleaseCandidate({
    appVersion,
    head,
    releaseCommit: release.commit,
    trackedStatus,
    deployedIdentity,
  });
};
try {
  assertNoReleaseArguments(process.argv.slice(2));
  release = assertReleaseEnvironment(process.env);
  const { version: packageVersion } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  appVersion = composeAppVersion(packageVersion, release.buildIndex);
  head = runGit(["rev-parse", "HEAD"]);
  await verifyDeploymentIdentity();

  const results = await runGateMatrix({
    gates: RELEASE_GATES,
    runCommand: async (gate) => {
      await verifyDeploymentIdentity();
      console.log(`Release gate ${gate.name}: RUN`);
      const result = spawnSync(gate.command, gate.args, {
        cwd: root,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.status === 0 && result.signal === null && result.error === undefined) {
        await verifyDeploymentIdentity();
        console.log(`Release gate ${gate.name}: PASS`);
      }
      return result;
    },
  });
  console.log(
    JSON.stringify({
      status: "PASS",
      version: appVersion,
      candidate: head,
      deployedIdentity,
      targetOrigin: release.expectedOrigin,
      gates: results,
    }),
  );
} catch (error) {
  const outcome = error?.outcome;
  const detail = redactDiagnostic(
    outcome?.stderr ||
      outcome?.stdout ||
      outcome?.error?.message ||
      error?.message ||
      "unknown failure",
    secrets,
  );
  console.error(detail);
  console.error(
    JSON.stringify({
      status: "FAIL",
      version: appVersion,
      candidate: head,
      deployedIdentity,
      targetOrigin: release?.expectedOrigin ?? null,
      failedGate: error?.gate ?? "preflight",
      gates: error?.results ?? [],
    }),
  );
  process.exitCode = 1;
}
