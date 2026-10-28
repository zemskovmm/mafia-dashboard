# Replacing printed player-card artwork

The numbered table cards have three printed decks alongside the existing Glass style:
French Classic (`classic`), Old-world Engraved (`heritage`) and Noir Royale (`noir`).
Their illustrations are ordinary standalone SVG files, not SVG strings inside React.

## Files and seat mapping

All production artwork lives under `apps/web/src/assets/player-cards/`:

```text
classic/   face-01.svg … face-10.svg, back.svg
heritage/  face-01.svg … face-10.svg, back.svg
noir/      face-01.svg … face-10.svg, back.svg
```

Each directory must contain exactly those eleven files. The two-digit face number is the
public table seat, from 1 through 10. It is **not** a role, player identity, profile avatar
or saved game field. Keep ten geometrically different illustrations per deck; changing
only their colours does not make a complete deck.

`apps/web/src/features/table/card-decks.ts` is the typed, explicit asset allowlist. Its only
lookup inputs are the printed style and seat number:

```ts
getCardArtwork(style, seat); // { front: ViteAssetUrl, back: ViteAssetUrl }
```

Only integer seats 1–10 select a face. Any other number returns the deck's neutral back
for both URLs. The lookup never constructs a runtime file path from an unchecked seat.
It does not decide privacy, reveals, departures or role labels.

The initial SVG bytes were extracted unchanged from the approved French, Heritage and
Noir preview JSON. Those preview files are not runtime dependencies or an artwork
regeneration step: edit the production SVG files for subsequent replacements.

## Replace one illustration or a whole deck

1. Export a self-contained decorative SVG and overwrite the corresponding file, for
   example `apps/web/src/assets/player-cards/heritage/face-04.svg`.
2. Keep its existing filename, SVG namespace and viewBox. To replace an entire deck,
   overwrite all ten faces and its single `back.svg` in that directory.
3. Keep actual text, seat/suit markers, role information, status indicators and controls
   out of the artwork. Do not add scripts, event handlers, `foreignObject`, embedded
   images, fonts, external resources or links. Use flattened vector geometry and literal
   colours rather than CSS, IDs, `href` references, `url(...)` paints or SVG animation.
4. Run the focused checks below and inspect the actual table at compact and normal
   sizes, including all three role-label placements and face-down cards.
5. Rebuild and deploy through the normal application release process when authorized.
   Replacing files alone does not update an already-deployed build.

**No JSX, manifest, role/state logic, preferences or canonical game data needs changing
when replacing the existing files.** Do not move them into `public/`, add remote image
URLs or introduce a runtime SVG loader. Adding a fourth printed style or changing the
asset format is a separate code change, not an artwork swap.

## Aspect ratios, framing and safe zones

- **Faces:** retain `xmlns="http://www.w3.org/2000/svg"` and
  `viewBox="0 0 160 256"` (5:8). This is the **illustration window**, not the full playing
  card. The surrounding table card remains portrait 5:7; its printed frame, seat corners,
  name/role bands and status rails are separate presentation layers. Do not stretch the
  illustration into a full-card template or bake those layers into the SVG.
- **Backs:** retain `viewBox="0 0 250 350"` (5:7). A back is a complete decorative reverse,
  so an opaque background and border may extend to the viewBox edges. Keep important
  motifs away from the rounded outer corners, where the card can clip them.
- **Face safe zone:** keep the recognizable subject in the central illustration area.
  Treat the outermost 5% of the illustration window as expendable ornament/bleed, not
  a place for essential detail. The approved decks have different portrait framing;
  preserve their existing visual scale when replacing individual seats.
- **Overlay safe zones:** leave the card's upper and opposite lower corner markers,
  left nomination/support rail, right foul/mute rail and lower identity band readable.
  Role text can appear below the name, inside its band or near the top. Do not place
  essential artwork where those live overlays belong; check all placements rather than
  relying on the SVG's standalone appearance. The illustration file cannot reposition
  the overlays or change card dimensions.

Fine detail should remain decorative at the retained compact table size. Use explicit
fills/strokes and suitable contrast for that deck's surrounding paper; do not rely on an
external stylesheet or the image inheriting the application's `currentColor`.

## One neutral back and preserved semantics

There is exactly one `back.svg` per deck, shared across every seat and assigned role.
Do not create seat-specific, role-coloured, crossed-out or elimination-specific backs.
The same neutral artwork must work for privacy, an unrevealed assignment and a completed
public departure without identifying which role is hidden. Face illustrations, embedded
suits and colours must likewise have no assigned-role meaning.

SVGs are decorative images. Keep their image alternative text empty and preserve the
card component's live accessible identity, actions and non-secret status descriptions.
Do not add SVG `title`, `desc`, text or ARIA labels as a substitute for those semantics.
Localized role text remains a separate live layer that the presentation removes before
privacy motion begins. An artwork swap must not alter the accessible name, visible
name/seat orientation, selection cue, action hit targets, foul/mute/nomination indicators,
reveal/departure timing, reduced-motion behavior or the Glass renderer and saved icons.

## Build URLs and cache-busting

The manifest statically imports every SVG with Vite's `?no-inline` asset query. Vite
therefore emits **all 33 files as content-hashed production assets**, even when a face is
smaller than the normal inline threshold. JavaScript receives URLs, not inline SVG or a
runtime network-fetch/injection routine. Development URLs intentionally look different
from built URLs.

Replacing a file's bytes and rebuilding changes that asset's production hash/URL; there
is no hand-maintained cache version or timestamp to increment. Keep the hashed output
names and references generated by the build together in the release. Normal browser
image loading and caching still apply; this is not a runtime artwork-upload mechanism.

## Checks

From the repository root:

```sh
npm run test -w @mafia/web -- src/features/table/card-decks.test.ts
npm run typecheck -w @mafia/web
npm run build -w @mafia/web
```

The focused suite checks exact deck/file inventory, valid standalone SVG XML and expected
viewBoxes, decorative-only content, absence of active/remote references and role text,
ten distinct geometry signatures per deck, every face mapping, shared backs and invalid
seat bounds. It deliberately does not pin file hashes, so valid artwork replacements do
not require updating expected bytes in tests. It is a regression check, not a sanitizer
or permission to accept untrusted uploads.

Also inspect the integrated table: a file/content test cannot prove overlay legibility,
privacy ordering or control behavior. The repository-wide final verification remains
`npm run check:local` under the project's IDD verification policy.
