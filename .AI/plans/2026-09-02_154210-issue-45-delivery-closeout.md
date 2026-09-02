# Deliver and close GitHub issue #45

## Goal

Deliver the approved, verified third-foul mute fix to `origin/main` and close only GitHub issue #45 with exact local verification evidence.

## Dependency

This plan begins only after [the issue #45 implementation plan](./2026-09-02_142916-third-foul-mute-lifecycle.md) is explicitly approved, fully implemented, and passes its focused checks plus `npm run check`.

## Plain-language summary

After the mute-rule fix is proven locally, preserve the approved plan in Git history, commit only the issue’s code and tests, push `main`, verify the remote commit, and close #45 with the checks that actually passed. No pull request, CI wait, deployment, or unrelated backlog work is included.

## Known workspace boundary

- Base at planning time: `main` at `fc7a371`, tracking `origin/main` without divergence.
- `.AI/plans/` already contains an untracked ten-item backlog plan set. Those unrelated files are preserved owner state and must not be staged, deleted, reformatted, or absorbed into issue #45.
- Only the two issue #45 plan files may be included in the plan-history commit and later removed under repository policy.

## Delivery steps

1. Before source implementation, recheck `main`, `origin/main`, issue #45, duplicate PRs, and the exact dirty path inventory. Stop if the base advanced materially, the issue is no longer open/ready, a duplicate appeared, or another writer owns the same files.
2. Stage only this closeout plan and the approved issue #45 implementation plan; verify the staged path set; commit them locally as the durable plan archive. Do not stage the broader untracked backlog plan set.
3. Implement and verify only the approved source/test scope. Review the final diff against issue #45 and reject UI, API, schema, foul-count, timer, winner, or unrelated cleanup changes.
4. After focused tests, the regression sabotage run, and `npm run check` pass on the final bytes, remove the two fulfilled issue #45 plan files. Confirm their approved bytes remain recoverable from the preceding plan commit.
5. Stage only the approved domain/server test paths plus deletion of the two issue #45 plan files. Verify the staged diff contains no secret, generated output, or unrelated plan artifact, then create the scoped feature commit without an auto-closing keyword.
6. Fetch `origin/main` and require it still to be the approved base before pushing. Push local `main`, fetch again, and verify `origin/main` equals the exact local feature commit SHA.
7. Post one issue #45 evidence comment naming the verified commit and the actual focused checks plus `npm run check`; read the comment back.
8. Close only issue #45 as the final mutation, then read back its number, title, state, state reason, URL, and comments. If push or readback fails, keep the issue open.

## Acceptance criteria

- The approved issue #45 behavior and tests are the only product changes delivered.
- The approved plan bytes are recoverable from Git history before their working-tree copies are removed.
- The unrelated untracked backlog plan set remains present and unstaged.
- `origin/main` resolves to the exact locally verified feature commit.
- Issue #45 has one truthful evidence comment and is closed only after remote verification.
- No pull request, CI wait, deployment, or other issue mutation occurs.

## Verification

- `git status --short --branch` and exact staged-path inspection before each commit.
- `git show --stat --oneline` and `git diff --check` for the final candidate.
- Focused checks and `npm run check` rerun after any post-test source edit.
- `git fetch origin` plus equality checks between local `HEAD` and `origin/main` after push.
- `gh issue view 45 --json number,title,state,stateReason,url,comments` after comment and again after closure.
