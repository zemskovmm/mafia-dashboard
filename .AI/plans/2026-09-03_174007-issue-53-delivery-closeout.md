# Issue #53: verified direct-main delivery and closure

> **For agent:** REQUIRED SUB-SKILL: Use requesting-code-review before delivery.

## Goal

Deliver the fully verified issue #53 implementation to `origin/main`, close the GitHub issue only after remote verification, and reconcile the intentionally dirty primary checkout without absorbing or losing unrelated plans.

## Plain-language summary

After all database, server, and browser behavior passes locally, freeze and independently review the exact change, remove the completed #53 plans, commit and push only this issue, verify GitHub has the same commit, post the evidence, close #53 last, and restore the original checkout with every unrelated plan unchanged.

## Preconditions

- All three implementation plans satisfy their acceptance criteria on one unchanged candidate tree.
- Focused server/web tests and `npm run check` pass on that exact tree.
- The independent immutable-diff reviewer reports no security or logic blockers.
- `origin/main` still points to the approved base or to a mechanically reconciled descendant containing no conflicting work.

## Delivery sequence

1. Freeze the ticket worktree's branch, HEAD, status, changed paths, and candidate diff; run `git diff --check`.
2. Stage only issue #53 source, tests, documentation, and completed-plan deletions. Assert the staged path set contains no neighboring plan or unrelated file.
3. Export the staged binary/full-index patch, record its SHA-256, and obtain independent review without allowing the reviewer to mutate the worktree.
4. If review or a required check causes any edit, invalidate the candidate identity and rerun affected tests, `npm run check`, and review.
5. Commit without an auto-closing keyword, preserving the earlier plan-only commit in direct-main history.
6. Fetch and prove `origin/main` has not diverged; push the ticket branch to `origin/main` without force.
7. Read back `refs/heads/main` from GitHub and require exact equality with the reviewed local commit.
8. Post one issue comment containing the delivered SHA and exact focused/full verification results; read the comment back.
9. Close issue #53 as the final external mutation and read back its native closed state.
10. In the original checkout, remove only the completed #53 plan copies, clear only their pre-existing index entries, fast-forward local `main`, and verify every unrelated staged/untracked path and SHA-256 matches the frozen baseline.

## Failure policy

- Do not push if verification, review, changed-path scope, or remote-base checks fail.
- Do not close the issue if push, remote-SHA readback, or evidence-comment readback fails.
- Never use stash, reset, clean, force-push, or history rewriting to reconcile the dirty primary checkout.
- If an unrelated primary path would be overwritten or any frozen hash differs, leave delivery intact and stop for Michael's reconciliation decision.

## Done when

- `origin/main` equals the reviewed issue #53 commit.
- The evidence comment is remotely readable and issue #53 is closed.
- The ticket plans are absent from the final tree but recoverable from the earlier plan-only commit on `main`.
- The primary checkout is fast-forwarded and every unrelated plan retains its original bytes and Git classification.
