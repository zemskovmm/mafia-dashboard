# Native Interaction and Landscape Ergonomics

## Supported core workflow

The v1 moderator workflow is supported with touch and pointer at the approved landscape viewports below. Native keyboard behavior follows [IDD-0003's Native interaction contract](../.idd/intent/IDD-0003.spec-host-controls-and-presentation.md#native-interaction); a complete keyboard-only workflow or gesture replacement is not promised.

| Profile        | Browser engine | CSS viewport |
| -------------- | -------------- | ------------ |
| Common laptop  | Chromium       | 1366 × 768   |
| Canonical iPad | WebKit         | 1366 × 1024  |
| Compact tablet | Chromium       | 1000 × 600   |

Core play must remain inside the fixed viewport with no document-level scrolling, clipping, or overlap. Core targets are at least 48 × 48 CSS pixels, allowing a 0.1px measurement tolerance for fractional browser layout.

## Native keyboard boundary

- `Tab` and `Shift+Tab` retain browser navigation through native controls without visible focus decoration.
- The macOS WebKit automation host may require `Option+Tab` and `Option+Shift+Tab` for Safari's full-control navigation. Check the actual control and activation, not a focus ring or scripted return focus.
- Native fields, selects, and ranges retain normal typing, editing, and keyboard behavior.
- Ordinary interface text is not selectable, including body-level dialogs. Editable fields retain native selection, caret movement, copying and replacement; explicit copy/download controls and pointer gestures are unchanged.
- Native buttons activate with `Enter` or `Space`.
- Native dialogs retain browser modal focus, `Escape` cancellation, and background inertness with application state synchronized. This is not an authored focus trap or custom Escape handler.
- Drawers and non-native popups retain visible Close/Cancel controls and their pointer/backdrop dismissal, not authored Escape handling or forced opening/return focus.
- Setup, role assignment, timer controls, privacy, phase progression, nominations, votes, penalties, night actions, music playback/fades, undo, and game completion remain part of the core touch/pointer workflow.

Playlist drag reordering and developer-only diagnostics are not core live-game actions and remain outside this native-keyboard acceptance boundary. Seat dragging and contextual card gestures do not require keyboard alternatives.

## Deliberately retired coverage

- Focused-card `F` fouls and `Shift+F10`/Context Menu player actions.
- Authored picker arrows/Enter/Escape, book key navigation, and drawer/non-native-popup Escape dismissal.
- Forced drawer/statistics-heading, entry, first-control, or trigger focus; authored autofocus, focus restoration, and focus traps.
- Focus outlines, borders, shadows, highlights, and focus-triggered decorative heat/sweeps.
- A complete keyboard-only setup-to-completion journey or keyboard parity for pointer/touch gestures.

Removing focus decoration deliberately reduces keyboard accessibility; retaining native behavior does not establish complete keyboard accessibility. Semantic selection, nomination, error, active-game, and status outlines remain independent of focus. Existing touch targets, accessible names/roles, reduced motion, gameplay safeguards, and readiness-based club-entry completion remain required.

## Automated verification

The contract above defines intended behavior. The command paths below are verification entry points, not a claim that every layout or physical-device check passes; native-control and focused scenario checks do not replace complete landscape qualification.

Run the landscape and retained-interaction matrix against a running web application:

```sh
APP_URL=http://127.0.0.1:5173 npm run verify:ui-hardening
```

Still-required coverage after verifier alignment includes:

- accessible control names and valid ARIA roles/attributes with a focused axe rule set;
- native typing/editing, Tab navigation, button activation, and native dialog cancellation;
- pointer/touch drawer and player-context behavior, with retired custom key/focus effects absent;
- 48px core target measurements;
- approved main/rail geometry, 28px timer-to-voting separation, viewport containment, document overflow, and pairwise core-control overlap;
- a complete setup-to-live-day path at every approved viewport.

Run the full moderator journey with:

```sh
APP_URL=http://127.0.0.1:5173 npm run verify:ui
```

## Other deliberate exclusions

Per the approved scope of GitHub issue #20, these are not part of this acceptance gate:

- screen-reader status announcements or new live regions;
- reduced-motion or animation changes;
- contrast or ambient-light evaluation;
- new non-color indicators.

The focused axe checks therefore cover names, roles, ARIA validity, labels, and focusability rather than color contrast. Existing behavior in the excluded areas is preserved.
