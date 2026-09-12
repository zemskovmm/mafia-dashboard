# AI Artifacts

Repository-local AI artifacts live only in this directory, not in parallel
`.hermes/`, `.claude/`, top-level `plans/` or `reports/` trees.

The root `.gitignore` keeps this directory's contents local by default. The only
trackable exceptions are this maintained guidance file and `plans/future/`.

- `plans/` — local current-item implementation, investigation and closeout plans.
  Keep plan-first approval; never commit or force-add these plans, including in
  plan-preservation commits.
- `plans/future/` — only genuine unfinished work discovered during implementation
  and outside the active item's scope may be committed here. Current blockers,
  review tasks and pending merge are not future-work exceptions.
- `reports/` and task directories — local logs, screenshots, browser mockups,
  recordings, review outputs and verification evidence; never commit them.
- `project-metadata/` — maintained, ignored local decisions, rationale, concise
  actual verification results, limitations and pending actions. Do not copy raw
  reports into metadata under another filename.
- `local-history/` — retained local recovery copies and backups, not active
  instructions or a requirement to preserve execution artifacts in Git history.

After verified handoff and retention of important information in metadata, remove
only the completed task's owned temporary plans, logs and reports. Preserve active
or blocked work, unrelated files, actual test inputs and backups. Untracking an
existing artifact requires an explicitly scoped change; ignore rules alone do not
remove tracked files. Historical commits remain unchanged unless history rewriting
is separately approved.

Ignored files still occupy disk space and are not remotely backed up by committing
these rules. Do not use `git clean -fdx` casually: it can erase ignored evidence,
credentials and local database state. Retention or disk cleanup is a separate,
explicitly scoped operation; no artifact contents are discarded by ignore rules.

See [`../AGENTS.md`](../AGENTS.md) for repository policy. Runtime code, product documentation, GitHub workflows, and deployment configuration do not belong here.
