# UI and local-development decisions

This is a historical, source-bound record of the delivered work, not a new implementation plan or a claim about the current live environment. Product instructions remain in [README.md](../../README.md) and [architecture.md](../../docs/architecture.md).

## Durable decisions

- Card fire uses the selected **B / turbulent flame sheets** design at **50% intensity and 1.6× animation speed**, retaining the prototype's internal time factor. It is procedural fire, not filmed or photorealistic footage. The fire contribution stays inside the rounded card behind readable content; ordinary external glow is separate.
- Lighting remains enabled. The **Raytracing** control selects the GPU/CSS renderer; it is a UI label, not a claim of physical ray tracing. Pulse controls remain separate from fire speed. SVG lighting fallback is not restored; unavailable GPU rendering uses restrained CSS warmth, and reduced motion is static.
- The shared ten-seat layout keeps seats 1 and 10 level at the bottom with upright cards and no Host tile. Header/status placement avoids the timer overlap. Role-draw return lives in the Manage menu, preserving selection and draw progress; player management has a return to the existing game/setup.
- Availability remains a binary selected/unselected state with immediate feedback. Keyboard focus stays visible without mouse/touch hover replacing the selected appearance.
- Normal local development uses a supervised native PostgreSQL/API/Vite stack. Persistent development data and disposable test databases are separate. The private HTTPS route supports iPad access; localhost-only and frontend-only modes are explicit alternatives. See the root README for current setup and commands; do not re-execute the superseded Docker/8080 plan.
- Local tests must not target the persistent development database. The real-backend verifier uses isolated services, a disposable database and synthetic sessions; it does not establish real Google-account sign-in or physical-iPad acceptance.
- Additional production verification is **not performed by default**. Existing deployment workflow checks remain unchanged; additional live probes require an explicit request. Git push, deployment and device acceptance are distinct outcomes.

Source anchors: [lighting shader](../../apps/web/src/features/effects/vgpu/lighting-shader.ts), [lighting runtime](../../apps/web/src/features/effects/vgpu/VgpuLightingRuntime.ts), [availability](../../apps/web/src/features/setup/AvailablePlayersScreen.tsx), [table](../../apps/web/src/features/table/GameTable.tsx), [setup navigation](../../apps/web/src/features/setup/SetupWizard.tsx), [player directory](../../apps/web/src/features/players/PlayersScreen.tsx), [local launcher](../../scripts/dev-local.mjs), [PostgreSQL lifecycle](../../scripts/local-postgres.mjs), [test runner](../../scripts/test-local.mjs), and [backend verifier](../../scripts/verify-local-backend.mjs).

## Historical qualification and delivery

| Candidate                                                                                                        | Recorded result                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI commit `b18989fa9a8398d996e9366a2373740931223a50`; tree `f806ab19912b7408727243fd709863bc3e603681`            | Isolated exact-tree check passed: 1,010 tests, 2 optional infrastructure-template assertions skipped. Built-bundle UI verification and independent UI/effects reviews passed.                                                               |
| Local-tooling commit `ad19114b9b05d21bd82a3ecdf0919784c981dbb3`; tree `831c27268e6206faf2f3e588e5bd44855d8b2acb` | Isolated exact-tree check passed: 1,024 tests, 2 optional assertions skipped. Real local-backend verification passed 13 stages; independent review found no blocking defects. Committed locally, without a push or deployment by that task. |

The UI [deployment workflow](https://github.com/zemskovmm/mafia-dashboard/actions/runs/34041549897) completed successfully for its exact source commit. No additional post-deployment probes were performed after the user's clarification. This is a historical workflow result, not a fresh production verification.

Prior failed attempts were not counted as passes: the isolated UI gate encountered clustered timeouts before its unchanged retry passed, and an initial review dispatch lost provider connectivity before successful replacement reviews.

## Evidence limits

- Fixed-time WebGL sample-B versus WGSL comparisons recorded a maximum channel difference of 1/255 on the reference material, with ordinary/table output invariance. Screen-blend matching against the reference material is not proof of exact equivalence against every production gradient.
- Browser fixtures, diagnostic GPU flags, WebKit emulation, sampled contrast and local multi-card benchmarks are not physical-iPad performance or full real-account verification. The selected design costs more GPU time than the preceding ribbons; its accepted slice count and appearance were not silently reduced.
- Release approval accepted the selected appearance for delivery. Do not convert that into an undocumented claim that every earlier physical-device acceptance criterion was directly measured.
- Raw local evidence includes screenshots, videos, logs, rejected prototypes, verification scripts and duplicate source snapshots. It remains available in the ignored task directories on this machine, not in the current Git tree or necessarily on another machine.

## Historical plans and recovery

The original 13 old plans and the approved artifact-housekeeping plan are preserved byte-for-byte in local provenance commit `83e3154e3eba5651a584cb741b143fc2c080e924`. They describe completed, superseded or historical qualification work; their old approval/status text is not a current instruction. After retirement, working copies remain under ignored `.AI/local-history/plans/`.

Recover an original using `git show 83e3154e3eba5651a584cb741b143fc2c080e924:.AI/plans/<original-filename>.md`. That commit must be available in the checkout; this housekeeping task makes local commits only.

The separate active game-save diagnostics investigation is outside this cleanup. It is neither archived, ignored nor committed by this task. Its incident-specific information is intentionally absent from this report.
