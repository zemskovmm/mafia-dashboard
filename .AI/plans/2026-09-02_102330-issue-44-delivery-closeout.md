# Issue 44 Delivery and Closure Plan

> **For Hermes:** Execute only after renderer selection, SVG player/table, and V-GPU plans all satisfy their focused acceptance criteria on one unchanged source tree.

**Goal:** Deliver all three verified issue #44 renderer modes to `origin/main`, preserve the plan set in Git history, post exact evidence, and close the issue last.

**Brief summary of upcoming changes:** No new product behavior is introduced here. This plan verifies legacy, SVG, V-GPU, fallback, reduced-motion, and responsive behavior; commits only issue #44 scope; pushes the reviewed `main`; verifies the remote SHA; comments with evidence; and closes #44 as the final mutation.

**Architecture:** Freeze one candidate, run focused and real-browser gates, run canonical `npm run check`, review exact dependency/source/lockfile diffs, create a plan-history commit followed by the implementation/plan-deletion commit, and push only if `origin/main` has not moved.

**Tech Stack:** Git/GitHub CLI, npm, Vite, Vitest, Playwright Chromium/WebKit, V-GPU/WebGPU.

**Non-goals:** PR/CI wait, deployment, production mutation, closing #23/#17, staging the unrelated reconcile plan, or weakening real-WebGPU evidence to a mock/readiness assertion.

---

## Task 1: Freeze state and run focused tests

1. Record branch, local HEAD, `origin/main`, worktree, open issue #44, and open PR state.
2. Start only the web Vite app:

```sh
npm run dev -w @mafia/web
```

3. Run focused tests:

```sh
npm run test -w @mafia/web -- \
  src/features/effects/lighting-preferences.test.ts \
  src/features/effects/LightingRendererContext.test.tsx \
  src/features/effects/PlayerCardLighting.test.tsx \
  src/features/effects/TableAmbientLighting.test.tsx \
  src/features/effects/vgpu/VgpuLightingRuntime.test.ts \
  src/features/effects/vgpu/VgpuLightingProvider.test.tsx \
  src/features/table/GameTable.test.tsx \
  src/App.test.tsx
```

Expected PASS with no warnings/errors.

## Task 2: Run renderer/browser acceptance

```sh
APP_URL=http://127.0.0.1:5173 npm run verify:ui
APP_URL=http://127.0.0.1:5173 npm run verify:ui-hardening
APP_URL=http://127.0.0.1:5173 npm run verify:lighting-vgpu
```

Verify and inspect:

- **Legacy:** existing card flares and static day/night table tint; player toggle hides only card effects.
- **SVG:** all card palettes, animated day/night ambience, player-toggle isolation, reduced-motion static frame.
- **V-GPU:** real Chromium adapter/runtime readiness, nonblack/nonuniform inspected screenshots for card/table states, resize, reduced motion, and cleanup.
- **Fallback:** WebKit/unsupported or injected failure retains V-GPU request, shows status, and renders SVG continuously.
- **Matrix:** 1366×768 Chromium, 1366×1024 WebKit, and 1000×600 Chromium have no clipping, washout, overlap, inaccessible controls, lost focus, or intercepted input.

Stop Vite after verification. A missing real adapter or black V-GPU capture blocks closure.

## Task 3: Run canonical gate and inspect exact candidate

```sh
npm run check
git diff --check
git diff --stat
git diff -- apps/web package.json package-lock.json scripts
```

Confirm:

- `vgpu` is the only intended dependency addition and lockfile change;
- no direct shader-loader dependency is present because WGSL is inline;
- server/domain/API/persistence code is unchanged;
- no screenshots/logs/credentials/generated temporary artifacts are staged;
- unrelated reconcile plan bytes/state are unchanged;
- every post-gate edit triggers the affected focused/browser probe and `npm run check` again.

## Task 4: Preserve plan history and commit exact scope

Stage only these six plans—never the whole `.AI/plans/` directory:

```sh
git add -- \
  .AI/plans/2026-09-02_102330-issue-44-lighting-plan-set.md \
  .AI/plans/2026-09-02_102330-lighting-renderer-selection.md \
  .AI/plans/2026-09-02_102330-player-card-led-lighting.md \
  .AI/plans/2026-09-02_102330-day-night-table-lighting.md \
  .AI/plans/2026-09-02_102330-vgpu-lighting-renderer.md \
  .AI/plans/2026-09-02_102330-issue-44-delivery-closeout.md
git diff --cached --name-only
git commit -m "docs(ai): plan issue 44 lighting renderers"
```

Then remove only those six completed plan files, stage their exact deletions plus reviewed issue #44 source/tests/package/lockfile/verifier changes, inspect cached name-status/check/diff, and commit:

```sh
git commit -m "feat(ui): add selectable lighting renderers (#44)"
```

The pre-existing untracked reconcile plan must remain untouched.

## Task 5: Push, verify, comment, and close last

1. Fetch and confirm `origin/main` still equals the captured base; stop if it moved.
2. Push current `main` normally.
3. Verify local HEAD, `origin/main`, `git ls-remote`, and GitHub commits API all return the same final SHA.
4. Post one issue #44 comment with:
   - final SHA/URL;
   - three renderer modes and defaults;
   - separate player-toggle behavior;
   - V-GPU requested/effective fallback contract;
   - focused tests, UI journey, Chromium/WebKit hardening, real WebGPU screenshot evidence, and `npm run check`;
   - explicit no PR, CI wait, or deployment statement.
5. Read the comment back and verify SHA/body.
6. Close #44, then read back `CLOSED`/`COMPLETED`, comments, remote SHA, and final worktree.

## Stop conditions

- Any focused/canonical/browser test fails.
- V-GPU cannot be exercised on a real adapter or its captures are black/unverifiable.
- SVG fallback blanks, changes requested selection, or lacks visible status.
- `origin/main` moves, staged scope includes unrelated files, or GitHub readback mismatches.
- Product code changes after final verification.

On a stop condition, leave #44 open and report the exact blocker.
