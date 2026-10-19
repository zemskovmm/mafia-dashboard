# La Verdad public website

`apps/site/` is the independent Russian-language club website. It preserves the former Tilda homepage and two game-analysis articles and introduces the separately hosted Mafia Dashboard. GitHub Pages serves its static output; no Node server, API, authentication, database or Docker container is needed for the website.

## Local development

Use the repository's Node 22+ / npm 10+ toolchain and installed workspaces:

```sh
npm run dev -w @mafia/site
```

Open <http://127.0.0.1:5174/>. This is separate from the dashboard's development port and requires no backend or Azurite. Ports are strict: an occupied port is an error, not permission to stop another process.

```sh
npm run test -w @mafia/site
npm run typecheck -w @mafia/site
npm run build -w @mafia/site
npm run preview -w @mafia/site
npm run test:browser -w @mafia/site
```

The preview serves `apps/site/dist` on <http://127.0.0.1:4174/>. Browser verification checks the built static files, not the Vite development fallback. The full repository gate remains `npm run check:local`, which invokes `npm run check` inside the owned test fixture; the website itself does not use that fixture.

The browser suite uses an installed Chrome channel and the Playwright WebKit browser. Its owned plain-static test servers use loopback ports 5194 and 5195 and stop after the run; they are not production website servers. A missing browser is a verification prerequisite to resolve explicitly, not an implicit installation. Screenshots/traces and temporary static-test builds stay Git-ignored under `.AI/`.

## Public URLs and build configuration

The static entries are the homepage and these article directory indexes:

- `/games/2026-08-17/`
- `/games/2026-09-06/`

A plain static host should redirect the corresponding directory URL without its trailing slash to the index. No application router or 404-to-SPA workaround is used. A project-prefix deployment prepends its base to these paths.

```sh
# Existing custom-domain target, not a DNS change:
SITE_ORIGIN=https://mafiamalaga.es npm run build -w @mafia/site -- --base=/

# Conventional project-site target, not a deployment:
SITE_ORIGIN=https://zemskovmm.github.io npm run build -w @mafia/site -- --base=/mafia-dashboard/
```

`SITE_ORIGIN` must be an HTTPS origin with no path or trailing slash. The build base is an absolute directory path ending in `/`. Canonical links, internal navigation and sitemap URLs use the same origin/base as the build. Without an explicit origin, root builds target `https://mafiamalaga.es` and prefixed builds target `https://zemskovmm.github.io`. Set an explicit origin for any other deployment.

The build emits `sitemap.xml`, `robots.txt` and `.nojekyll`. A repository-prefixed `robots.txt` is not an origin-level robots policy; search crawlers use the host's root policy. Register the correct sitemap when activating that deployment.

## GitHub Pages publication

The independent `.github/workflows/deploy-site-pages.yml` workflow is **manual-only** and restricted to `main`. It does not run on ordinary pushes or pull requests and does not change the Azure release workflow. It reads the existing Pages origin/base, runs the website checks, builds only this workspace and uploads **only `apps/site/dist`**.

Before an explicitly authorized first publication:

1. Check that the repository/account supports Pages and that an existing Pages site or custom domain will not be overwritten. Do not make a private repository public as a workaround.
2. Configure the repository's Pages source to **GitHub Actions** and review the `github-pages` environment protections. The workflow deliberately does not enable Pages itself.
3. Review and publish the scoped source changes through the authorized Git workflow, then explicitly dispatch **Public website · GitHub Pages** from `main`.
4. Read back the deployment URL, all three public pages, no-slash article redirects, local assets, canonical/sitemap URLs and the external app link. Local checks are not proof of live Pages behavior.
5. Configure a custom domain, verification records, DNS and HTTPS only under separately approved authority. Keep Tilda available until the replacement is verified; do not claim a domain by adding a `CNAME` file during local development.

The conventional project URL for this repository is `https://zemskovmm.github.io/mafia-dashboard/`. This documentation does not imply that Pages is enabled or a deployment exists.

## Content and privacy boundary

Maintain ordinary static HTML, shared styles and locally bundled artwork. Preserve the original Russian wording and article meaning; game-engine changes do not authorize rewriting historical club content. The application section is deliberately separate and may be updated as verified app capabilities change.

The public app image uses synthetic demonstration data, not real player identities or a production session. The website never calls the dashboard API or embeds the app. Opening the external app is ordinary navigation and its own authentication rules apply.

The one external app destination is `hostingAppUrl` in `apps/site/src/site-settings.ts`. The homepage and footer are composed at build time from `apps/site/src/content/`; they are not fetched or rendered by JavaScript. The small browser script only handles user-requested videos and their dialog lifecycle.

### Assets and attribution

`apps/site/asset-sources.json` records the origin and SHA-256 of each locally retained source asset, font, license and real-app image. The content regression fixture separately protects the complete source wording, lists and links. Do not replace these expectations with hashes of changed output just to make a regression pass.

The original **Doloman Pavljenko** font is deliberately not shipped: its redistribution permission was unresolved, and Michael selected an openly licensed alternative. **Poiret One** supplies the geometric display typography under SIL OFL 1.1. The original **Ubuntu** body fonts remain unmodified under UFL 1.0, with their embedded copyright notices intact. Both license texts ship in `public/licenses/` and are linked from the footer. This authorized font substitution changes some heading widths and line wrapping; the replica is not pixel-identical to Tilda.

The six original feature icons retain the visible **Icons from Tilda Publishing** footer link required by their license, with the license text bundled. Public club artwork, portraits and the article illustration are reused only for the owner-authorized replica; they are not asserted to be public-domain assets. Source CDN thumbnails/resizes, unused fonts and Tilda runtime/tracking code are not bundled.

Telegram and the existing Vimeo/YouTube resources remain intentional external services. Their availability and playback policies are outside this static website. Keep direct video links available rather than silently replacing unavailable media. Do not add Tilda scripts, tracking, a live signup form or private application data to the publication artifact.
