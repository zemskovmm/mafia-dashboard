# Plan 1 — Harden runtime browser and server security controls

**Status:** Completed and verified — 2026-08-30  
**Parent:** [Issue #19 plan set](2026-08-30_173748-issue-19-security-hardening-plan-set.md)  
**Goal:** Add tested HTTP/browser defenses for the deployed SPA and API while preserving OAuth, YouTube playback, and the accepted club authorization model.

## Scope

### In

- Fastify security headers and CSP.
- HTTPS-only HSTS behavior tied to the canonical public URL.
- No-store handling for authenticated/sensitive API responses.
- YouTube IFrame `origin` binding.
- Focused route, static-hosting, OAuth, and player regressions.

### Out

- Authorization-role changes, alternate data projections, scanner workflows, and threat-model documentation.

## Expected files

- `apps/server/package.json`
- `package-lock.json`
- `apps/server/src/app.ts`
- `apps/server/src/app-security.test.ts`
- `apps/web/src/features/music/YouTubePlaylistPlayer.tsx`
- `apps/web/src/features/music/YouTubePlaylistPlayer.security.test.tsx`

The focused security regressions are kept separate from the larger neighboring suites so they can run without unrelated database setup.

## Continuation checkpoint

The source changes and initial focused regressions exist. Before accepting this plan, extend or confirm coverage for static SPA/asset responses and OAuth compatibility, rerun the focused server/player suites on the current worktree, and exercise a production-like browser path so the CSP is validated behaviorally rather than only as header text.

## Implementation sequence

1. **Write failing server regressions.**
   - Assert API, health, and static responses carry a consistent hardened baseline.
   - Assert CSP denies framing and objects, restricts scripts/frames to the app plus required YouTube origins, and permits only the minimum font/style/image sources used by the current UI.
   - Assert `Referrer-Policy` prevents OAuth callback query details from crossing origins.
   - Assert `X-Content-Type-Options`, frame protection, and the existing `Permissions-Policy` remain present.
   - Assert HSTS and `upgrade-insecure-requests` are enabled only for an HTTPS `PUBLIC_APP_URL`, so local HTTP development is not upgraded unexpectedly.
   - Assert `/api/**` responses are `Cache-Control: no-store`; hashed static assets retain normal static caching behavior.

2. **Install and configure the Fastify-native header middleware.**
   - Add the current Fastify-5-compatible `@fastify/helmet` release through npm so the lockfile records the exact transitive tree.
   - Register it globally before routes and static serving.
   - Use an explicit CSP rather than undocumented defaults. Preserve the fixed YouTube IFrame API script/frame, Google Fonts, Google profile/YouTube thumbnails, data-backed club logos, and same-origin API calls while denying plugins, framing, arbitrary scripts, and form submission to other origins.
   - Keep the existing `picture-in-picture=()` product restriction.
   - Do not expose runtime nonces or weaken `script-src` with `unsafe-inline`/`unsafe-eval`.

3. **Bind YouTube playback to the application origin.**
   - Pass `window.location.origin` as the IFrame API `origin` player parameter, matching Google’s documented defense.
   - Add a component regression that captures `YT.Player` options and proves the exact origin is sent without altering queue/playback behavior.

4. **Verify compatibility.**
   - Run focused server and music-player tests plus server/web typechecks.
   - Build and run the production server locally; read back root, auth-session, health, and static-asset headers.
   - Exercise the YouTube setup path with the existing browser verifier or a focused Playwright check to detect CSP breakage.

## Acceptance criteria

- Every response has the reviewed security-header baseline.
- HTTPS production responses include HSTS; HTTP local responses do not force HTTPS.
- CSP blocks arbitrary scripts, objects, and framing while the SPA, Google Fonts, account/playlist images, and YouTube IFrame API still work.
- OAuth/session/game APIs are explicitly non-cacheable.
- The YouTube player receives the exact application origin.
- No club authorization, secret-event, replay, or persistence behavior changes.
- Focused tests pass before proceeding to Plan 2.
