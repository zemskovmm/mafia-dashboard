# Keyboard and Landscape Ergonomics

## Supported core workflow

The v1 moderator workflow is supported with touch, pointer, and keyboard at the approved landscape viewports below.

| Profile        | Browser engine | CSS viewport |
| -------------- | -------------- | ------------ |
| Common laptop  | Chromium       | 1366 × 768   |
| Canonical iPad | WebKit         | 1366 × 1024  |
| Compact tablet | Chromium       | 1000 × 600   |

Core play must remain inside the fixed viewport with no document-level scrolling, clipping, or overlap. Core targets are at least 48 × 48 CSS pixels, allowing a 0.1px measurement tolerance for fractional browser layout.

## Keyboard contract

- `Tab` and `Shift+Tab` follow DOM order and show a visible focus outline.
- The macOS WebKit automation host uses `Option+Tab` and `Option+Shift+Tab`, matching Safari's full-control navigation, and asserts the actual next control before returning focus.
- Native buttons activate with `Enter` or `Space`.
- `Shift+F10` or the Context Menu key opens the contextual player action for the focused seat.
- Opening a contextual player action focuses its first enabled control; `Escape` closes it and restores focus to the originating seat.
- Opening Log, Manage, or Dev from the fixed toolbar focuses the drawer heading; `Escape` closes the drawer and restores focus to its trigger.
- Setup, role assignment, timer controls, privacy, phase progression, nominations, votes, penalties, night actions, music playback/fades, undo, and game completion are part of the core keyboard path.

Playlist drag reordering and developer-only diagnostics are not core live-game actions and are outside this keyboard acceptance boundary.

## Automated verification

Run the landscape and keyboard matrix against a running web application:

```sh
APP_URL=http://127.0.0.1:5173 npm run verify:ui-hardening
```

The verifier checks:

- accessible control names and valid ARIA roles/attributes with a focused axe rule set;
- toolbar-drawer and player-context keyboard focus behavior;
- 48px core target measurements;
- approved main/rail geometry, 28px timer-to-voting separation, viewport containment, document overflow, and pairwise core-control overlap;
- a complete setup-to-live-day path at every approved viewport.

Run the full moderator journey with:

```sh
APP_URL=http://127.0.0.1:5173 npm run verify:ui
```

## Deliberate exclusions

Per the approved scope of GitHub issue #20, these are not part of this acceptance gate:

- screen-reader status announcements or new live regions;
- reduced-motion or animation changes;
- contrast or ambient-light evaluation;
- new non-color indicators.

The focused axe checks therefore cover names, roles, ARIA validity, labels, and focusability rather than color contrast. Existing behavior in the excluded areas is preserved.
