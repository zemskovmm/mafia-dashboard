# IDD Intent Index

This index helps humans and Coding Agents find relevant current intent documents.
It is not the source of truth.

Current `IDD-NNNN` documents directly under `.idd/intent/` contain normative
product intent, ADRs, or active spikes.

`GLOSSARY.md`, when present, is an optional unnumbered vocabulary support file
and is not listed in this index.

Git history is the source for deleted or previous document versions.

For shared or cross-cutting product intent, use `Area`, `Notes`, or equivalent
discovery metadata to make the scope obvious to planners. Existing projects do
not need a schema migration; keep their current INDEX shape when it already
communicates this information.

Implementation-only durable constraints belong in the optional
`.idd/engineering/` layer, not in this index.

## Current documents

The specifications below own the confirmed product behavior and shared data contracts.

The `Document` column contains stable `IDD-NNNN` identifiers only. Do not put
filenames, file paths, or Markdown links in this column. Resolve an identifier to
the unique current `.idd/intent/IDD-NNNN.*.md` file when the document must be
opened.

| Document | Role | Area                                | Notes                                                                    | Replaces |
| -------- | ---- | ----------------------------------- | ------------------------------------------------------------------------ | -------- |
| IDD-0001 | Spec | Club access and player identity     | Membership, consent and privacy-preserving historical retention          |          |
| IDD-0002 | Spec | Club Mafia gameplay                 | One current engine, setup, Casper, voting, discipline and outcomes       |          |
| IDD-0003 | Spec | Host controls and presentation      | Native input/privacy, setup touch roles and upward gameplay penalties    |          |
| IDD-0004 | Spec | Game records and continuity         | Engine-independent partial facts, optional history, recovery and Undo    |          |
| IDD-0005 | Spec | Data compatibility and preservation | Safe admission, guarded deletion and gated one-time normalization        |          |
| IDD-0006 | ADR  | Azure Table and Blob persistence    | Atomic authority, exact ordinary saves and bounded conversion exception  |          |
| IDD-0007 | Spec | Club statistics and rating          | Observed denominators, unchanged lifetime Elo and named tournament scope |          |
