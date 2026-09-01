# Issue #5 Data Model and Migration Documentation Plan

> **For Hermes:** Implement only after the normalized persistence plan is green; keep documentation truthful to the final schema.

**Goal:** Document the relational ruleset/assignment projection and its forward-only migration/rollback contract so operators and future contributors can reason about authority, compatibility, and recovery.

**Architecture:** Update the existing entity model, persistence ADR, and self-hosted deployment guide rather than adding a new overlapping document. Clearly distinguish the authoritative JSON snapshot from relational query/constraint projections and distinguish application rollback from database restoration.

**Tech Stack:** Markdown, Mermaid ER diagrams, Prettier.

**Non-goals:** Changing runtime behavior; writing backup/restore scripts (#22); release procedures (#23); configurable rulesets (#8); adding a public/private projection; rewriting unrelated historical ADR rationale.

---

### Task 1: Update the current physical entity model

**Objective:** Make the documented PostgreSQL model exactly match the implemented catalog, session reference, and active role projection.

**Files:**
- Modify: `docs/entity-model.md:12-205`
- Reference: `apps/server/src/schema.sql`

**Steps:**
1. Add the versioned ruleset catalog and its relationship to sessions to the Mermaid physical model.
2. Add session ruleset identity fields and the nullable active-player role field.
3. Update physical-key notes to explain:
   - fixed v1 catalog identity and referential restrictions;
   - club-scoped active seat/player uniqueness;
   - host rows versus pre-draw/assigned participant rows;
   - completed roles live in `game_player_results` after active rows are removed.
4. State that relational rows are synchronized projections and that `game_sessions.state` remains the restorable authority.
5. Cross-check every documented column/key against PostgreSQL catalog assertions in `schema-migration.test.ts`.

### Task 2: Reconcile architecture and authorization wording

**Objective:** Remove stale implications that the server maintains public/private session representations.

**Files:**
- Modify: `docs/adr/0001-typescript-modular-monolith.md:31-40,64-79`
- Reference: `rules.md`
- Reference: completed GitHub issue #42

**Steps:**
1. Extend the current aggregate section with the normalized ruleset/active-assignment projection and its atomic synchronization boundary.
2. Replace the stale “explicit server-side secret filtering” consequence with the accepted contract: authenticated club members receive the same game data, while membership and club isolation—not response redaction—protect access.
3. Preserve the ADR’s replay/head authority and snapshot-supersession history; do not rewrite past decisions unrelated to #5.

### Task 3: State the supported forward and rollback policy

**Objective:** Give operators an explicit, accurate response to migration failure and application rollback.

**Files:**
- Modify: `docs/self-hosted-deployment.md:70-90,180-200`

**Steps:**
1. Document that this schema change is additive, advisory-locked, and transaction-protected; failed attempts roll back and successful reruns converge idempotently.
2. Document compatible previous-image behavior: defaults preserve fixed-v1 session writes and extra projection/catalog objects are ignored by the older application.
3. State that no reverse schema migration is supported. Application rollback reuses the additive schema; destructive/incompatible future changes require a tested database restore rather than manual DDL reversal.
4. Keep backup/restore commands out of this issue; link the operational dependency to #22 only if a tracker link is useful.

## Verification

Run:

```bash
npm exec prettier -- --check docs/entity-model.md docs/adr/0001-typescript-modular-monolith.md docs/self-hosted-deployment.md
```

Then mechanically compare names/relationships against `apps/server/src/schema.sql` and the migration catalog assertions. The full repository format/check gate belongs to the delivery plan.

## Risks and stop conditions

- Do not claim rollback restores data; application rollback and database restoration are separate.
- Do not describe alternate/configurable rulesets before #8 implements them.
- If implementation changes table/column names, update this plan’s named entities before editing docs rather than documenting planned-but-absent schema.
