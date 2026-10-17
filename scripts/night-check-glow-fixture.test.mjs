import { URL, URLSearchParams } from "node:url";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { tsImport } from "tsx/esm/api";

const domain = await tsImport("../packages/game-domain/src/index.ts", import.meta.url);
const source = await readFile(new URL("./fixtures/night-check-glow.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile(
  "night-check-glow.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
// Execute the fixture's own pre-mount construction, not a duplicated scenario.
const harnessIndex = parsed.statements.findIndex(
  (statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) => declaration.name.getText(parsed) === "Harness",
    ),
);
assert.ok(harnessIndex > 0, "the real fixture must retain its mount boundary");
const construction = parsed.statements
  .slice(0, harnessIndex)
  .filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getText(parsed))
  .join("\n");
const executable = ts.transpileModule(construction, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const role of ["don", "sheriff"]) {
  for (const prior of [false, true]) {
    test(`night glow constructs identity-only ${role} ${prior ? "prior" : "same-night"} elimination with separate display profiles`, () => {
      let inputs;
      const result = runInNewContext(
        `${executable}\nJSON.stringify({ initial, owner, other, profiles });`,
        {
          ...domain,
          createSetup(players, ...args) {
            inputs = players;
            return domain.createSetup(players, ...args);
          },
          URLSearchParams,
          window: { location: { search: `?role=${role}${prior ? "&prior=1" : ""}` } },
        },
      );
      const { initial, owner, other, profiles } = JSON.parse(result);
      const roster = JSON.parse(JSON.stringify(inputs));
      assert.deepEqual(
        roster,
        Array.from({ length: 10 }, (_, index) => ({
          id: `p-${index + 1}`,
          seat: index + 1,
        })),
      );
      assert.deepEqual(
        profiles,
        roster.map(({ id, seat }) => ({ id, nickname: `Player ${seat}` })),
      );
      assert.equal(
        initial.phase,
        prior ? (role === "don" ? "night-sheriff" : "night-resolution") : `night-${role}`,
      );
      assert.equal(domain.isNightCheckEligible(initial, role), !prior);
      assert.doesNotThrow(() => domain.createInitialGameBaseline(initial));
      assert.equal(owner.role, role);
      assert.equal(other.role, "citizen");
      assert.notEqual(owner.seat, other.seat);
      assert.equal(initial.players.find(({ seat }) => seat === owner.seat).status, "eliminated");
      assert.equal(initial.players.find(({ seat }) => seat === other.seat).status, "eliminated");
      assert.equal(initial.nightResult.kind, prior ? "miss" : "kill");
      if (!prior) assert.equal(initial.nightResult.targetSeat, owner.seat);
      assert.doesNotMatch(JSON.stringify(initial), /"(?:rulesEdition|rulesetId|rulesetVersion)":/);
      assert.doesNotMatch(JSON.stringify(initial), /"(?:name|nickname)"|Player /);
      assert.match(source, /<PlayerDirectoryProvider profiles=\{profiles\}>/);
    });
  }
}
