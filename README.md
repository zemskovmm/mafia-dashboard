# Mafia Dashboard

A self-hosted web dashboard for moderating in-person Sport / Club Mafia games.

## Status

The project is in research and product-planning. The earlier Swift/Xcode prototype has been removed; this repository will contain the web application only.

## Documentation

- [`rules.md`](rules.md) — researched game rules, canonical MVP behavior, moderator workflows, data model, deployment baseline, and open product decisions.
- [GitHub issues](https://github.com/zemskovmm/mafia-dashboard/issues) — dependency-aware implementation backlog.
- [Issue #1](https://github.com/zemskovmm/mafia-dashboard/issues/1) — owner decisions required before implementation.

## Architecture direction

The deployment target is Docker Compose with an application container and PostgreSQL persistence. The application framework will be selected and documented through [issue #2](https://github.com/zemskovmm/mafia-dashboard/issues/2).
