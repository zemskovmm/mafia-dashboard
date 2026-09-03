# Deliver and close GitHub issue #46

## Goal

Deliver the approved, verified Foul-control visibility fix to `origin/main` and close only GitHub issue #46 with exact local verification evidence.

## Dependency

This plan begins only after [the issue #46 implementation plan](./2026-09-02_142916-foul-control-visibility.md) is explicitly approved, fully implemented, and passes its focused checks plus `npm run check`.

## Plain-language summary

After the Foul-control fix is proven locally, preserve the approved plan in Git history, commit only issue #46’s code and tests, push `main`, verify the exact remote commit, and close #46 with the checks that actually passed. No pull request, CI wait, deployment, or unrelated backlog work is included.

## Known workspace boundary

- Base at planning time: `main` and `origin/main` both resolve to `dda769a206e64b391718c58c21ac1fa703df2f8c`.
- `.AI/plans/2026-09-02_142916-club-active-game-lock.md` is already staged owner state.
- The reliability backlog index and eight other issue plans are untracked owner state. They must remain present and must not be staged, unstaged, deleted, reformatted, or absorbed into issue #46.
- Only the issue #46 implementation plan and this closeout plan may be included in the plan-history commit and later removed under repository policy.

## Delivery steps

1. Before source implementation, recheck `main`, `origin/main`, issue #46’s complete thread, duplicate pull requests, and the exact dirty path inventory. Stop if the base advanced materially, the issue is no longer open/ready, a duplicate appeared, or another writer owns the same source/test paths.
2. Stage and commit only the two issue #46 plan files by explicit path, without altering or committing the already-staged club-lock plan or any other backlog artifact. Verify the commit’s path set and confirm all unrelated plan state is unchanged.
3. Implement and verify only the approved `GameScreen` source/test scope. Review the final diff against issue #46 and reject domain, persistence, schema, API, translation, red-card swipe, or unrelated cleanup changes.
4. After the focused regression, sabotage run, full web tests, and `npm run check` pass on final bytes, remove the two fulfilled issue #46 plan files. Confirm their approved bytes remain recoverable from the preceding plan commit.
5. Stage only the approved source/test paths plus deletion of the two issue #46 plan files. Inspect the staged diff and commit using explicit path arguments so the unrelated already-staged plan cannot enter the feature commit.
6. Fetch `origin/main` and require it still to be the approved base before pushing. Push local `main`, fetch again, and verify `origin/main` equals the exact local feature commit SHA.
7. Post one issue #46 evidence comment naming the verified commit and the checks that actually passed; read the comment back.
8. Close only issue #46 as the final mutation, then read back its number, title, state, state reason, URL, and comments. If commit, push, or remote verification fails, leave the issue open.

## Acceptance criteria

- The approved issue #46 behavior and regression coverage are the only product changes delivered.
- The approved plan bytes are recoverable from Git history before their working-tree copies are removed.
- The staged club-lock plan and all other backlog plans remain byte-for-byte present and outside both issue #46 commits.
- `origin/main` resolves to the exact locally verified feature commit.
- Issue #46 has one truthful evidence comment and is closed only after remote commit verification.
- No pull request, CI wait, deployment, or other issue mutation occurs.

## Verification

- `git status --short --branch` and exact staged/unstaged path inspection before each commit.
- `git show --stat --oneline` and `git diff --check` for the final candidate.
- Focused tests, the regression sabotage run, full web tests, and `npm run check` rerun after any post-test source edit.
- `git fetch origin` plus exact SHA equality checks between local `HEAD` and `origin/main` after push.
- `gh issue view 46 --json number,title,state,stateReason,url,comments` after the evidence comment and again after closure.
