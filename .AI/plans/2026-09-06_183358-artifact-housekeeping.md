# Repository-local artifact housekeeping plan

**Status:** Clarified and inspected read-only; awaiting implementation approval.

**Plain-language summary:** Keep useful decisions in Git, stop generated screenshots/logs/mockups and verification snapshots from appearing as untracked work, and retire stale plans without losing their contents. Preserve the separate active game-save diagnostics work. Make local commits only; do not push or deploy.

**Goal:** Give every artifact in the original untracked inventory an explicit, preservation-safe Git disposition.

**Architecture:** Add narrowly scoped rules to the root `.gitignore`, retain a concise decision/verification record under `.AI/reports/`, and preserve old plan bytes in Git history before relocating their working copies to ignored `.AI/local-history/plans/`. Keep `.AI/plans/` and `.AI/reports/` generally trackable.

**Tech stack:** Git, Markdown, existing npm checks and disposable PostgreSQL test runner.

**Non-goals:** Application/tooling changes, new tests of production, deployments, pushes, database or service changes, deleting local artifact contents, blanket ignoring `.AI/`, staging credentials, or consuming another workstream's plans or edits.

## Observed inventory and boundaries

- `main` at `ad19114b9b05d21bd82a3ecdf0919784c981dbb3`; no tracked edits or staged changes at inspection.
- Initial inventory: 942 untracked files. Later inspection: 943, because a separate active plan appeared during this audit.
- Existing tracked `.AI/README.md` and the two existing `.AI/reports/` files must remain tracked and intact except the intentional README explanation.
- `.gitignore` already protects credentials, node/build/test outputs, and local PostgreSQL/backups. Preserve those rules.
- Raw reports include historically correct but now stale statements such as “uncommitted”, obsolete flame designs, and pending visual acceptance. Do not publish them wholesale as current status.
- User selected: ignore generated artifacts, retain useful documents in Git, preserve files locally, and make no push.

### Generated directories to ignore, not delete or commit

| Directory under `.AI/` | Original untracked files |
| --- | ---: |
| `azure-template-contracts/` | 4 |
| `card-fire/` | 129 |
| `deployment-verification/` | 21 |
| `fire-samples/` | 12 |
| `ipad-layout/` | 36 |
| `lighting-polish/` | 83 |
| `lighting-visuals/` | 47 |
| `local-backend/` | 22 |
| `local-tooling-commit/` | 242 |
| `turbulent-card-fire/` | 91 |
| `ui-release/` | 242 |

Use root-anchored directory rules, not global rules for all Markdown, JSON, scripts, or `.AI/`. Also ignore the new local-only `.AI/local-history/` and `.AI/artifact-housekeeping/` directories used by this cleanup.

### Original plans to retain historically and retire from the active folder

Exactly these 13 existing files are in scope:

- `2026-09-05_120327-local-tailscale-run.md`: superseded Docker/8080 approach, not the current native development workflow.
- `2026-09-06_121333-availability-interaction.md`
- `2026-09-06_121333-card-fire-index.md`
- `2026-09-06_121333-interior-fire.md`
- `2026-09-06_134049-01-seat-orientation.md`
- `2026-09-06_134049-02-table-clearance.md`
- `2026-09-06_134049-03-header-title.md`
- `2026-09-06_134049-04-role-back-action.md`
- `2026-09-06_134049-05-role-status-banner.md`
- `2026-09-06_134049-06-always-on-player-lighting.md`
- `2026-09-06_134049-07-player-directory-back.md`
- `2026-09-06_134049-ipad-layout-index.md`
- `2026-09-06_153749-turbulent-card-fire.md`

Their implementation outcomes are already delivered or superseded. Record remaining physical-device evidence limitations honestly in the retained report; do not infer hardware verification from release approval or browser emulation.

### Explicitly excluded concurrent work

Do not edit, ignore, move, or stage `.AI/plans/2026-09-06_182955-game-save-rejection-diagnostics.md`. It is a newly active investigation, contains incident-specific details, and belongs to another workstream. Leave any additional concurrent paths outside this pinned inventory untouched and visible. A final untracked listing containing such excluded work is not a cleanup failure.

## Implementation after approval

1. **Freeze the exact inventory.** Recheck HEAD/index/status. Save original paths, sizes and content hashes under `.AI/artifact-housekeeping/`; distinguish generated directories, the exact old-plan list, this cleanup plan, and excluded concurrent files. Never read credential files. Stop on overlapping writers or ambiguous ownership; do not stash or broadly reset other work.
2. **Retain useful knowledge.** Create `.AI/reports/2026-09-06-ui-local-development-decisions.md` with current durable decisions and bounded verification provenance: sample B at 50%/1.6×, no SVG lighting fallback, always-on lighting with Raytracing/pulse controls, the accepted table/navigation changes, native persistent development versus disposable tests, and no extra production verification by default. Cite current source/product docs and the known UI/tooling commits. Distinguish historical test results, skipped checks, fixture/GPU diagnostics, and real-device limitations. Exclude private player/club data, credentials, raw logs and machine-specific incident details.
3. **Preserve plan history before retirement.** Make one explicitly scoped local provenance commit containing the exact 13 old plan files and this approved cleanup plan. Record their Git blob IDs and mark their historical/superseded disposition in the retained report rather than rewriting the original bytes. Do not include the new diagnostics plan. This intermediate commit is a recovery point, not a new implementation backlog.
4. **Apply narrow ignore/documentation changes.** Edit `.gitignore` with the generated-directory rules above. Update `.AI/README.md` to explain tracked active plans/reports versus local-only evidence/history, and that ignored files are not remotely backed up and must not be removed with `git clean -fdx` casually.
5. **Retire without discarding contents.** Relocate the 13 historical plans to `.AI/local-history/plans/` with their basenames and bytes unchanged. After this cleanup's acceptance checks pass, retire its own plan the same way. Stage only their tracked-path removals, `.gitignore`, `.AI/README.md`, and the new report for the final cleanup commit. Verify original plan bytes are recoverable from the provenance commit and present locally at the new paths. No other files are deleted or moved.
6. **Verify and commit the final scoped state.** Check exact index paths, perform the validation below, obtain a bounded review of the cleanup diff, and make the local cleanup commit. If concurrent source work exists, qualify only this candidate in an isolated `.AI/artifact-housekeeping/` export; do not absorb or reset it. Verify the committed tree matches the qualified candidate. Do not push either commit or the already-unpushed tooling commit.

## Validation / acceptance

- Programmatically reconcile every original inventory path: ignored in place, plan preserved in Git history and relocated locally, or explicitly retained as a reviewed document. No unexplained missing file.
- `git check-ignore --stdin` confirms all generated inventory paths are ignored; `git check-ignore --no-index` confirms existing tracked reports, representative future `.AI/plans/example.md` and `.AI/reports/example.md`, and the active diagnostics plan are not ignored.
- No application source, secrets, database files, snapshots, binaries, generated evidence, or excluded concurrent work appear in the cleanup index.
- Plan blob IDs and local-copy hashes match the originals. Existing tracked report bytes are unchanged. Background logs may legitimately append; do not stop the local app or claim append-only activity was caused by cleanup.
- `git diff --check` and Markdown formatting pass. Run the repository's `npm run check` through the disposable-database workflow against the final scoped candidate. Gitignore is not an ESLint ignore rule; do not weaken lint configuration to conceal artifact failures. Use an isolated candidate if unrelated local artifacts interfere.
- Final Git status has no unexplained original artifacts. Report excluded active/concurrent files explicitly, plus the local commit IDs and their unpushed state.
- No production probes, push, deployment, local database mutation, service restart, or destructive filesystem cleanup.

## Risks and tradeoffs

- Narrow ignore rules require consciously adding future artifact directories; this is intentional so new useful plans/reports are not silently hidden.
- Historical plans need a local provenance commit before retirement to satisfy exact-history preservation. The final tree will not present completed plans as active tasks; original files also remain locally available.
- Ignored evidence still occupies disk space and is not backed up by these commits. Disk cleanup or external archival requires a separate request.
- Concurrent diagnostics work appeared during inventory. Preserve its visibility and ownership; never claim the whole repository is clean merely because this task's artifact set is reconciled.
