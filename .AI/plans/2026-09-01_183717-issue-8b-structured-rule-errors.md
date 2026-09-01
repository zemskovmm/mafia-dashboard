# Issue #8B — Structured Illegal-Action Errors

> **For Hermes:** Execute only as part of the approved #8 plan set.

**Goal:** Make every rejected public rules action expose a stable machine-readable error contract while preserving the current immutable, exception-based API and human-readable messages.

**Architecture:** Introduce one exported `GameRuleError extends Error` with a small stable code union and readonly serializable details. Public setup/game/day/night action guards throw this class. Replay-envelope, malformed-persistence, hash, parent-link, and schema corruption remain integrity errors rather than being mislabeled as moderator rule violations. No function changes from “return state or throw” to a repository-wide `Result` type.

**Non-goals:** HTTP error-response redesign; UI error presentation; error telemetry; converting replay corruption into rule violations; changing action semantics; replacing exceptions with discriminated result objects; generic correction/override events.

## Source-backed starting point

- Public domain actions currently use plain `Error` throughout `setup.ts`, `game.ts`, `day-actions.ts`, and `night-actions.ts`.
- `game-events.ts` mixes two categories: action-precondition failures from `applyGameEvent`, and canonical replay-integrity failures (shape, version, hash, sequence, parent, phase metadata).
- The domain is immutable: actions spread/copy state and return a new value, but rejected-action non-mutation is not accepted through a focused contract test.
- App callers already handle `Error` generically, so an `Error` subclass is backward compatible.

## Error contract

Create an intentionally small code set rather than one code per message:

- `invalid-setup`
- `invalid-phase`
- `invalid-player`
- `inactive-player`
- `duplicate-action`
- `incomplete-action`
- `invalid-action`
- `terminal-game`

`GameRuleError` carries:

- `name: "GameRuleError"`
- stable `code`
- existing human-readable `message`
- readonly `details` limited to JSON-safe action context such as `action`, `phase`, `seat`, `targetSeat`, or `expectedPhase`

Do not include hidden roles, private check results, secret shot assignments, stack traces, or whole game snapshots in details.

## Task 1: Add the reusable error primitive

**Files:**
- Create: `packages/game-domain/src/rule-error.ts`
- Modify: `packages/game-domain/src/index.ts`
- Create: `packages/game-domain/src/rule-error.test.ts`

**Steps:**
1. Define and export `GameRuleErrorCode`, a JSON-safe details type, the class, and a tiny helper used to throw it without repeated boilerplate.
2. Preserve `instanceof Error`, the original message, and a predictable `toJSON` shape if serialization is included; avoid dependencies.
3. Add tests for class identity, stable fields, JSON-safe output, and the absence of secret/context object leakage.
4. Run `npm test -w @mafia/game-domain -- src/rule-error.test.ts`.

## Task 2: Classify rejected public rule actions

**Files:**
- Modify: `packages/game-domain/src/setup.ts`
- Modify: `packages/game-domain/src/game.ts`
- Modify: `packages/game-domain/src/day-actions.ts`
- Modify: `packages/game-domain/src/night-actions.ts`
- Modify only if a public guard is added there: `packages/game-domain/src/night-transition.ts`
- Modify: relevant existing focused tests in `packages/game-domain/src/*.test.ts`

**Steps:**
1. Trace every exported setup/game/day/night action and replace its moderator/action precondition `throw new Error(...)` with the closest stable rule code and minimal safe details.
2. Keep message text unchanged unless it is factually wrong; existing UI/log assertions should not require broad rewrites.
3. Classify terminal-state attempts as `terminal-game` even if the attempted action normally reports `invalid-phase`.
4. Leave private impossible-state assertions as ordinary integrity errors when they indicate corrupted state rather than an illegal moderator action.
5. Add table-driven tests covering representative rejected actions in setup, day, voting/car-crash, night, Best Move, winner, draw, and cancellation phases.
6. For every representative rejection, clone the supplied state before the call and assert deep equality afterward. Do not mutate then roll back.
7. Run all focused domain suites touched by the classification.

## Task 3: Preserve the action/integrity boundary in canonical events

**Files:**
- Modify: `packages/game-domain/src/game-events.ts`
- Modify: `packages/game-domain/src/game-replay.test.ts`
- Modify if present after implementation search: the existing game-event security/validation test file

**Steps:**
1. Let `applyGameEvent` propagate `GameRuleError` when a valid-shaped canonical draft attempts an illegal game action.
2. Keep malformed payload fields, unsupported replay versions, invalid hashes, duplicate/cross-game IDs, broken parents, and phase/day metadata mismatches as replay-integrity errors.
3. Add paired tests proving the distinction: a valid-shaped nomination in the wrong phase yields `GameRuleError`; a malformed nomination payload or tampered replay chain does not.
4. Assert that failed event application leaves the original projection unchanged and creates no `GameLogEntry`.
5. Run `npm test -w @mafia/game-domain -- src/game-replay.test.ts` plus the actual event validation/security suite.

## Acceptance criteria

- Every public mutating rules action rejects illegal moderator input with `GameRuleError` and a stable code/details shape.
- Human-readable error messages remain useful and existing callers remain source-compatible.
- Error details never expose roles, secret checks, or secret shot data.
- Rejected actions and rejected canonical event creation leave the supplied state and event collection unchanged.
- Replay corruption remains distinguishable from a legal-state rule violation.

## Stop conditions

- If a public API must switch to a `Result` return type to satisfy a caller, stop and return to plan mode because that is a material repository-wide contract change.
- If classifying an error exposes secret role/check/shot information, omit those details and retain only a safe generic code.
- If an existing test relies on a plain `Error` constructor rather than `instanceof Error`/message semantics, update only when the new subclass remains behaviorally compatible; otherwise report the conflict.
