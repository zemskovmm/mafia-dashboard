import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const subscription = "00000000-0000-0000-0000-000000000001";
const tenant = "00000000-0000-0000-0000-000000000002";
const client = "00000000-0000-0000-0000-000000000003";
const principal = "00000000-0000-0000-0000-000000000004";
const staging = {
  AZURE_SUBSCRIPTION_ID: subscription,
  AZURE_TENANT_ID: tenant,
  AZURE_RESOURCE_GROUP: "rg-mafia-dashboard-staging-neu",
  AZURE_LOCATION: "northeurope",
  AZURE_IDENTITY_NAME: "mafiadashboard-stg-github",
  GITHUB_REPOSITORY: "zemskovmm/mafia-dashboard",
  GITHUB_ENVIRONMENT: "staging",
  GITHUB_FEDERATED_SUBJECT: "repo:zemskovmm@8973322/mafia-dashboard@1320321469:environment:staging",
};

function fixtureRun(extra = {}, fixture = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mafia-oidc-bootstrap-"));
  const callsPath = join(directory, "calls.jsonl");
  const statePath = join(directory, "state.json");
  const configPath = join(directory, "fixture.json");
  writeFileSync(callsPath, "");
  writeFileSync(
    statePath,
    JSON.stringify({ variables: {}, credential: fixture.credential ?? null }),
  );
  writeFileSync(configPath, JSON.stringify(fixture));
  const executable = `#!${process.execPath}
const fs = require('node:fs');
const tool = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(process.env.FIXTURE_CONFIG, 'utf8'));
const state = JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE, 'utf8'));
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify([tool, ...args]) + '\\n');
const at = flag => args[args.indexOf(flag) + 1];
const starts = value => args.slice(0, value.length).join(' ') === value.join(' ');
const emit = value => process.stdout.write(typeof value === 'string' ? value + '\\n' : JSON.stringify(value));
const scope = '/subscriptions/' + process.env.AZURE_SUBSCRIPTION_ID + '/resourceGroups/' + process.env.AZURE_RESOURCE_GROUP;
const identity = {
  id: scope + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/' + process.env.AZURE_IDENTITY_NAME,
  location: 'northeurope', tenantId: '${tenant}', clientId: '${client}', principalId: '${principal}',
  ...config.identity,
};
if (config.fail && [tool, ...args].join(' ').startsWith(config.fail)) process.exit(7);
if (tool === 'az') {
  if (starts(['account', 'show'])) emit({ id: '${subscription}', tenantId: '${tenant}', ...config.account });
  else if (starts(['account', 'set']) || starts(['group', 'create']) || starts(['identity', 'create'])) {}
  else if (starts(['group', 'show'])) emit({ id: scope, location: 'northeurope', ...config.group });
  else if (starts(['identity', 'show'])) {
    const query = at('--query');
    emit(['clientId', 'principalId'].includes(query) ? identity[query] : identity);
  }
  else if (starts(['identity', 'federated-credential', 'list'])) emit(state.credential ? [state.credential] : []);
  else if (starts(['identity', 'federated-credential', 'show'])) {
    if (!state.credential) process.exit(3);
    emit({ ...state.credential, ...config.credentialReadback });
  }
  else if (starts(['identity', 'federated-credential', 'create']) || starts(['identity', 'federated-credential', 'update'])) {
    state.credential = { name: at('--name'), issuer: at('--issuer'), subject: at('--subject'), audiences: [at('--audiences')] };
  }
  else if (starts(['role', 'assignment', 'list'])) emit(config.roles ?? (state.role ? [state.role] : []));
  else if (starts(['role', 'assignment', 'create'])) state.role = {
    scope: at('--scope'), principalId: at('--assignee-object-id'),
    roleDefinitionId: '/subscriptions/${subscription}/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c',
  };
  else throw new Error('Unexpected Azure fixture command: ' + args.join(' '));
} else {
  if (starts(['variable', 'set'])) state.variables[args[2]] = at('--body');
  else if (starts(['variable', 'get'])) emit(config.variableReadback ?? state.variables[args[2]]);
  else throw new Error('Unexpected GitHub fixture command: ' + args.join(' '));
}
fs.writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
`;
  for (const name of ["az", "gh"])
    writeFileSync(join(directory, name), executable, { mode: 0o700 });
  try {
    const result = spawnSync("bash", ["scripts/bootstrap-azure-oidc.sh"], {
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        ...staging,
        ...extra,
        FIXTURE_CALLS: callsPath,
        FIXTURE_STATE: statePath,
        FIXTURE_CONFIG: configPath,
      },
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 256 * 1024,
    });
    assert.equal(result.error, undefined);
    const calls = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { ...result, calls, state: JSON.parse(readFileSync(statePath, "utf8")) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("OIDC bootstrap rejects a subject for the wrong environment before invoking either provider", () => {
  const result = fixtureRun({
    GITHUB_FEDERATED_SUBJECT:
      "repo:zemskovmm@8973322/mafia-dashboard@1320321469:environment:production",
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, [], "invalid environment binding must not contact providers");
});

const option = (call, name) => call[call.indexOf(name) + 1];
const matching = (result, prefix) =>
  result.calls.filter((call) => call.slice(0, prefix.length).join(" ") === prefix.join(" "));

test("staging bootstrap binds exact immutable subject, RG Contributor and environment variables with readbacks", () => {
  const result = fixtureRun();
  assert.equal(result.status, 0, result.stderr);
  const [credential] = matching(result, ["az", "identity", "federated-credential", "create"]);
  assert.ok(credential, "staging needs its own federated credential");
  assert.equal(option(credential, "--name"), "github-staging");
  assert.equal(option(credential, "--identity-name"), staging.AZURE_IDENTITY_NAME);
  assert.equal(option(credential, "--subject"), staging.GITHUB_FEDERATED_SUBJECT);
  assert.equal(option(credential, "--issuer"), "https://token.actions.githubusercontent.com");
  assert.equal(option(credential, "--audiences"), "api://AzureADTokenExchange");
  const [grant] = matching(result, ["az", "role", "assignment", "create"]);
  assert.ok(grant, "new identity needs scoped Contributor");
  assert.equal(option(grant, "--role"), "Contributor");
  assert.equal(option(grant, "--assignee-object-id"), principal);
  assert.equal(option(grant, "--assignee-principal-type"), "ServicePrincipal");
  assert.equal(
    option(grant, "--scope"),
    `/subscriptions/${subscription}/resourceGroups/${staging.AZURE_RESOURCE_GROUP}`,
  );
  const writes = matching(result, ["gh", "variable", "set"]);
  assert.deepEqual(writes.map((call) => call[3]).sort(), [
    "AZURE_CLIENT_ID",
    "AZURE_LOCATION",
    "AZURE_RESOURCE_GROUP",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_TENANT_ID",
  ]);
  for (const call of [...writes, ...matching(result, ["gh", "variable", "get"])]) {
    assert.equal(option(call, "--repo"), staging.GITHUB_REPOSITORY);
    assert.equal(option(call, "--env"), "staging");
  }
  assert.equal(matching(result, ["gh", "variable", "get"]).length, writes.length);
  assert.equal(matching(result, ["az", "identity", "federated-credential", "show"]).length, 1);
  assert.equal(matching(result, ["az", "role", "assignment", "list"]).length, 2);
  assert.doesNotMatch(JSON.stringify(result.calls), /Owner|listKeys|secret|password|access-token/);
});

test("bootstrap requires explicit target inputs and refuses mixed-environment or malformed bindings without provider calls", () => {
  for (const key of [
    "AZURE_IDENTITY_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_ENVIRONMENT",
    "GITHUB_FEDERATED_SUBJECT",
    "AZURE_SUBSCRIPTION_ID",
    "AZURE_TENANT_ID",
    "AZURE_RESOURCE_GROUP",
  ]) {
    const result = fixtureRun({ [key]: "" });
    assert.notEqual(result.status, 0, key);
    assert.deepEqual(result.calls, [], key);
  }
  for (const extra of [
    { AZURE_RESOURCE_GROUP: "rg-mafia-dashboard-prod-weu" },
    { AZURE_IDENTITY_NAME: "mafiadashboard-github" },
    { GITHUB_ENVIRONMENT: "preview" },
    { GITHUB_REPOSITORY: "other/repository" },
    { GITHUB_REPOSITORY: "zemskovmm/mafia-dashboard; false" },
    { GITHUB_FEDERATED_SUBJECT: `${staging.GITHUB_FEDERATED_SUBJECT}:extra` },
    { GITHUB_FEDERATED_SUBJECT: "repo:zemskovmm@8973322/mafia-dashboard:environment:staging" },
    { AZURE_LOCATION: "westeurope" },
    { AZURE_SUBSCRIPTION_ID: "bad/subscription" },
  ]) {
    const result = fixtureRun(extra);
    assert.notEqual(result.status, 0, JSON.stringify(extra));
    assert.deepEqual(result.calls, [], JSON.stringify(extra));
  }
});

test("explicit production bootstrap reuses only matching existing trust and Contributor without expanding authority", () => {
  const subject = staging.GITHUB_FEDERATED_SUBJECT.replace(/staging$/, "production");
  const scope = `/subscriptions/${subscription}/resourceGroups/rg-mafia-dashboard-prod-weu`;
  const result = fixtureRun(
    {
      GITHUB_ENVIRONMENT: "production",
      GITHUB_FEDERATED_SUBJECT: subject,
      AZURE_RESOURCE_GROUP: "rg-mafia-dashboard-prod-weu",
      AZURE_IDENTITY_NAME: "mafiadashboard-github",
    },
    {
      credential: {
        name: "github-production",
        subject,
        issuer: "https://token.actions.githubusercontent.com",
        audiences: ["api://AzureADTokenExchange"],
      },
      roles: [
        {
          scope,
          principalId: principal,
          roleDefinitionId: `/subscriptions/${subscription}/providers/Microsoft.Authorization/roleDefinitions/b24988ac-6180-42a0-ab88-20f7382dd24c`,
        },
      ],
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(matching(result, ["az", "identity", "federated-credential", "create"]).length, 0);
  assert.equal(matching(result, ["az", "identity", "federated-credential", "update"]).length, 0);
  assert.equal(matching(result, ["az", "role", "assignment", "create"]).length, 0);
});

test("account, identity and existing federation mismatches stop before grants or GitHub writes", () => {
  for (const fixture of [
    { account: { tenantId: "foreign-tenant" } },
    { account: { id: "foreign-subscription" } },
    { group: { location: "westeurope" } },
    { identity: { tenantId: "foreign-tenant" } },
    { identity: { id: "/foreign/identity" } },
    { identity: { principalId: "" } },
    {
      credential: {
        name: "github-production",
        subject: staging.GITHUB_FEDERATED_SUBJECT.replace(/staging$/, "production"),
        issuer: "https://token.actions.githubusercontent.com",
        audiences: ["api://AzureADTokenExchange"],
      },
    },
  ]) {
    const result = fixtureRun({}, fixture);
    assert.notEqual(result.status, 0, JSON.stringify(fixture));
    assert.equal(matching(result, ["az", "role", "assignment", "create"]).length, 0);
    assert.equal(matching(result, ["gh", "variable", "set"]).length, 0);
    assert.equal(matching(result, ["az", "identity", "federated-credential", "create"]).length, 0);
    assert.equal(matching(result, ["az", "identity", "federated-credential", "update"]).length, 0);
  }
});

test("provider failures and failed readbacks fail closed instead of repairing trust or reporting success", () => {
  for (const fixture of [
    { fail: "az identity federated-credential list" },
    { fail: "az role assignment list" },
    { fail: "az role assignment create" },
    { fail: "gh variable set" },
    { fail: "gh variable get" },
    { credentialReadback: { subject: "wrong-subject" } },
    { roles: [] },
    { roles: { unexpected: [] } },
    { variableReadback: "wrong-value" },
  ]) {
    const result = fixtureRun({}, fixture);
    assert.notEqual(result.status, 0, JSON.stringify(fixture));
    assert.doesNotMatch(result.stdout, /Configured GitHub OIDC/);
    assert.equal(matching(result, ["az", "identity", "federated-credential", "update"]).length, 0);
  }
});
