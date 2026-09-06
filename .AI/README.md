# AI Artifacts

Repository-local AI-generated artifacts live only in this directory.

- `plans/` — active implementation and investigation plans.
- `reports/` — reviewed decisions and concise evidence summaries intended for Git.
- `archive/` — unresolved or superseded artifacts retained for unique rationale; completed work is removed and remains available in Git history.

Generated evidence, browser mockups, recordings, logs and verification snapshots
stay local in the task directories explicitly listed in the root `.gitignore`.
New task directories require an intentional disposition; neither `.AI/` nor all
Markdown/JSON files are ignored wholesale. Active plans and useful reports remain
eligible for Git, subject to review for private data and stale claims.

`local-history/` holds optional local copies of retired plans whose original bytes
have first been preserved in Git history. These are historical records, not active
instructions. The [UI and local-development record](reports/2026-09-06-ui-local-development-decisions.md)
identifies the preserved plan commit and summarizes the current decisions.

Ignored files still occupy disk space and are not remotely backed up by committing
these rules. Do not use `git clean -fdx` casually: it can erase ignored evidence,
credentials and local database state. Retention or disk cleanup is a separate,
explicitly scoped operation; no artifact contents are discarded by ignore rules.

See [`../AGENTS.md`](../AGENTS.md) for repository policy. Runtime code, product documentation, GitHub workflows, and deployment configuration do not belong here.
