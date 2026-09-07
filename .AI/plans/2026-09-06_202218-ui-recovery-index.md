# UI and unavailable-club recovery plan set

> **Completed — non-executable.** All six scoped outcomes are implemented and verified. See [verification](../reports/ui-recovery/verification.md). Original planning sections below are historical. This untracked set is retained only pending Git-history-safe retirement; do not re-execute it.

## Plain-language summary
Remove Host view from headings; hide disconnected music while keeping YouTube connection in settings; hide Critical in private mode; match player-card flames to their red outline; add the automatic Guessing Game / угадайка pill; and repair confirmed local discard/open recovery for games belonging to unavailable clubs.

## Status
Implementation approved with Michael’s “go”, completed, and locally verified. Full `npm run check:local` passed with 1,065 tests; Chrome/WebKit acceptance passed, the red hue was visually approved, and final independent rereview passed without blockers. No commit, push, deployment, credential change, or live game mutation was performed. The unrelated staged diagnostics plan remains untouched.

## Confirmed decisions
- Music player disappears completely without a connected music account. Connection remains in settings, not in the hidden player's footprint.
- Critical is hidden in private mode, superseding the earlier always-visible-while-masked requirement.
- Fire means the flames inside Mafia-shooter and selected-availability player cards; match their existing red outline.
- угадайка is automatic for ongoing games with exactly three living players, including one mafia, throughout active Day and Night phases. It is a derived indicator, not a new canonical phase or a change to rules.
- English label: Guessing Game, selected by the user rather than the initially suggested Final Three.
- Guessing Game replaces Critical for this condition. Both are hidden in private mode.
- Recovery requires explicit local-discard confirmation and must preserve cross-tab exact-snapshot guards and ordinary unsynced-game release protection.

## One-goal implementation plans
| Plan | Requests | Outcome |
| --- | --- | --- |
| [Header title](2026-09-06_202218-header-title.md) | 1 | Remove redundant Host view copy consistently in EN/RU |
| [Account-gated music](2026-09-06_202218-account-gated-music.md) | 2–3 | No disconnected player; clear YouTube onboarding in existing settings |
| [Critical privacy](2026-09-06_202218-critical-pill-privacy.md) | 4 | Critical disappears while private information is hidden |
| [Red fire hue](2026-09-06_202218-red-fire-hue.md) | 5 | Flame hue matches the red surrounding highlight |
| [Guessing Game indicator](2026-09-06_202218-guessing-game-indicator.md) | 6–8 | Derived localized three-player endgame indicator replaces Critical |
| [Unavailable-club recovery](2026-09-06_202218-unavailable-club-recovery.md) | 9 | Confirmed, guarded local discard and correct navigation |

## Suggested implementation order
1. Unavailable-club recovery, because it blocks workspace access.
2. Account-gated music and discoverable connection.
3. Header title cleanup.
4. Critical privacy, followed by Guessing Game (same render site; retain independent acceptance criteria).
5. Red fire hue with focused browser comparison.

The plans are independently useful. Guessing Game depends on the shared privacy decision, not on changing critical music detection. Do not introduce a broad endgame-state framework or combine unrelated persistence changes.

## Key findings and limits
- The unavailable-owner dialog selects normal release whenever a target club is blocked, instead of the existing confirmed discard path. Normal release intentionally rejects unresolved storage. This source-confirmed mismatch is consistent with the screenshot, but the exact device's failure has not been reproduced.
- The existing YouTube connection link is nested in collapsed settings and omitted when OAuth is unconfigured. Player mounting currently ignores connection status. Actual environment OAuth configuration is unknown; no secrets or live account state were inspected.
- Existing tests explicitly require Critical while privacy-masked. Those expectations must change, while critical detection used by music remains intact.
- GPU fire uses an orange/yellow palette separate from the red semantic outline. Preserve motion, intensity, masking and unrelated lights while changing hue.

## Acceptance and verification policy
Each linked plan has scoped source anchors, tasks, risks, acceptance criteria and focused verification commands. Implement with focused failing regression tests, then minimal fixes and real isolated browser checks. Use desktop/tablet layout evidence for UI; WebKit/tablet and multi-context storage coverage for recovery; GPU-ready, CSS fallback and reduced-motion evidence for fire.

Run `npm run check:local` at final integration: `scripts/test-local.mjs` invokes the mandatory `npm run check` with a disposable PostgreSQL test database. Do not use a live backend or a user's active games for verification. Browser evidence belongs under `.AI/` and must distinguish fixtures from live service results.

No tests/builds or runtime reproductions were run in this planning phase. Source inspection is evidence for the plans, not a claim that fixes already work.

## Scope boundary
No implementation until explicit later-turn approval. No commit, push, issue closure, OAuth credential changes, deployment, schema migration or modification of live games. Preserve the pre-existing `.AI/plans/2026-09-06_182955-game-save-rejection-diagnostics.md` unchanged; it is not part of this approval set. Remove successfully implemented plan files only after their verification, following AGENTS.md.

## Approval request
Approve this set to implement the six scoped outcomes above with local verification, without committing or deploying. Any selected subset can be approved independently, subject to the Guessing Game/privacy dependency.
