# Step 65 — GitHub Pages deploy, README rewrite and the demo media

Branch: `ci/65-pages-and-readme` · Reviewer: GPT-6.1 Sol · Rounds: — · Status: open · Verdict after triage: —

## Scope

The pre-publish plan (2026-11-09, "### 65") makes the documentation site public on GitHub Pages and rewrites the repository's landing README before 0.1.0. User decision 48 A (2026-11-13) settles the demo media: one headless Playwright recording of each of four scenarios (multi-tab sharing, credential refresh, server rendering, live-feed reconnect), converted into short GIFs for the README and MP4 plus WebM for the site, embedded as `<video autoplay muted loop playsinline>`. Nothing under `packages/tscache/src/` changes.

| Commit (by subject)                                                  | What                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci: deploy the documentation site to github pages`                  | `.github/workflows/pages.yml`; VitePress `base: "/tscache/"`; the demo hub's links to `docs:dev` under the base; `docs/supply-chain.md` (the new `id-token: write` job, a GitHub Pages check); its size in `docs/INDEX.md`.            |
| `chore(demo): record the demo scenarios headless`                    | `scripts/demo/record.ts`, its Fallow entry, the four GIFs (`docs/media/`) and eight videos (`site/public/media/`), and a `docs/INDEX.md` row for `docs/media/`.                                                                        |
| `docs(site): embed the demo videos where each scenario is explained` | The home page and the auth, SSR and live-feeds guides; the Demo hub page's paragraph on the recordings.                                                                                                                                |
| `docs: rewrite the landing readme`                                   | `README.md`; `packages/tscache/README.md` (the measured figure step 67 left for this step, and the sharing GIF); `homepage` in `packages/tscache/package.json`; sizes in `docs/INDEX.md`, and the site row names `site/public/media/`. |
| `docs(review): step 65 scope and verification`                       | This file, and the review-file count and size in `docs/INDEX.md`.                                                                                                                                                                      |

## The Pages workflow

`.github/workflows/pages.yml` runs on every push to `main` and on `workflow_dispatch` (to deploy again by hand, for example after Pages is first enabled). Pull requests do not run it: `ci.yml` already builds the site (`bun run docs:build` in `scripts/ci.sh`), and only `main` deploys.

- **Jobs.** `build` checks out, installs with `bun install --frozen-lockfile`, builds the package (`bun run build`, the order of `scripts/ci.sh`), builds the site (`bun run docs:build`) and uploads `site/.vitepress/dist` as the Pages artifact. `deploy` (needs `build`) runs `configure-pages` and `deploy-pages` in the `github-pages` environment, whose URL is the deploy's page URL.
- **Permissions.** Top level `permissions: {}`. `build`: `contents: read`. `deploy`: `pages: write` and `id-token: write` (deploy-pages proves the deploy's origin with the OIDC token). No other job holds a write permission. The checkout sets `persist-credentials: false`. No step interpolates an event field into a `run:` script; the only expression is `steps.deployment.outputs.page_url`, in the environment URL.
- **Concurrency.** `group: pages`, `cancel-in-progress: false`: one deploy at a time, a running deploy is never cancelled half done, and a newer push replaces one still waiting.
- **Action pins** (full commit SHAs, the latest release of each, looked up with `gh api repos/<action>/releases/latest` and `gh api repos/<action>/git/ref/tags/<tag>`, both lightweight tags pointing at commits):

  | Action                          | Version | Commit                                     |
  | ------------------------------- | ------- | ------------------------------------------ |
  | `actions/configure-pages`       | v6.0.0  | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` |
  | `actions/upload-pages-artifact` | v5.0.0  | `fc324d3547104276b827a68afc52ff2a11cc49c9` |
  | `actions/deploy-pages`          | v5.0.1  | `368f82528645a54fb793d4d04e342629a3f51346` |

  The workflow's other actions reuse the pins of `ci.yml`: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `oven-sh/setup-bun` v2.2.0 (Bun 1.4.2, Node 24). Dependabot's `github-actions` group covers the new file.
- **`docs/supply-chain.md`.** Its environment check expected `id-token: write` only in `release.yml` and `scorecard.yml`; it now names `pages.yml`'s `deploy` job, and says why npm's trusted publisher does not accept that token (it names neither `release.yml` nor `npm-publish`). A new "GitHub Pages" check reads the Pages setting.

### The repository setting the director changes after merge

No repository setting was changed by this step. Pages is not enabled yet, so the first run of `pages.yml` after the merge fails at `configure-pages` (it cannot find a Pages site). The director then enables Pages with GitHub Actions as its source:

```sh
gh api -X POST repos/anishbenji/tscache/pages -f build_type=workflow
```

(Settings → Pages → Build and deployment → Source: GitHub Actions.) If Pages already exists with a branch source, the same setting is `gh api -X PUT repos/anishbenji/tscache/pages -f build_type=workflow`. Then deploy once by hand and check:

```sh
gh workflow run pages.yml --ref main
gh api repos/anishbenji/tscache/pages --jq '{build_type, html_url}'
# expected: {"build_type":"workflow","html_url":"https://anishbenji.github.io/tscache/"}
```

Enabling Pages with GitHub Actions as its source creates the `github-pages` environment the `deploy` job names.

### The base

`site/.vitepress/config.ts` sets `base: "/tscache/"`, the path GitHub Pages serves a project site under. In the built site every root-relative `href` and `src` starts with `/tscache/` (checked below), including the `<source>` elements of the embedded videos, which VitePress rewrites. The demo hub's two links to the local site (`scripts/demo/hub.ts`) move under the base, since `docs:dev` now serves at `http://localhost:5173/tscache/`.

## The demo recordings

`bun scripts/demo/record.ts [--reuse-builds] [--only <name>[,<name>]]` starts the demo (`scripts/demo.ts`, the same launcher as `bun run demo`), records each scenario in headless Chromium, converts the recordings with ffmpeg, and stops the demo. It is a heavy job and ran under the heavy-job lock. ffmpeg is a local tool (`brew install ffmpeg`, installed for this step: ffmpeg 9.0.2), not a repository dependency; the script fails at once without it.

- **The stage.** Every scenario runs on the vanilla reference client (`reference/vanilla`, the hub's "Reference client: vanilla", port 5408) in a fresh browser context, so a fresh SharedWorker and empty storage. The recorded page is a stage the script serves on `127.0.0.1`: a caption, a strip of the app's mock-backend counters since the scenario began (read from `GET /api/stats`: `pages` summed as backend fetches, `points` as bars served, `refused`, `refreshes`, and `streams`, which is shown as is), and the app in one or two iframes. The iframes are same-site with the stage (one host, other port), so the app's storage is not partitioned, and two iframes of the app's origin share its SharedWorker, Web Locks, BroadcastChannel and localStorage as two tabs do. The README and the captions on the site say that the two tabs are two frames of one page. (Playwright's Chromium also runs with `ThirdPartyStoragePartitioning` disabled, so the recording would share the worker even across sites; the stage does not rely on that, since it is same-site.)
- **Checks.** Each scenario checks what its captions claim before the recording is kept, and fails otherwise; it prints what it observed. The captions that carry numbers take them from the backend's counters and the page's own summary, never from a constant.
- **Clips.** Each recording is trimmed to the scenario (from its start mark to its end), then written as an MP4 (H.264, CRF 26, `yuv420p`, `+faststart`), a WebM (VP9, CRF 38) and a GIF (8 fps, 720 px wide, a 96-colour palette made from the clip, Bayer dither). The videos keep the recorded 960 × 600.

What each shows, with the run's observations (final recording, 2026-11-13) and the code each claim rests on:

- **`multi-tab-sharing`.** Tab 1 opens with an empty cache and the SharedWorker fetches the history; tab 2 opens, reports mode `shared`, and draws the same bars at once; the backend serves it only the newest bars. Observed: tab 1 drew 721 bars after 1 fetch of 721 bars; tab 2 drew 721 bars, mode `shared`, after 1 more fetch of 2 bars. Code: the reference session reads the visible range through the shared client (`reference/shared/src/session.ts`); the bar forming now is provisional (`reference/shared/src/live.ts` header: a bar at or after `finalizedUntil` "stays provisional: the cache stores it, but a read that fetches still asks the backend for it"), which is the newest bars tab 2 fetches; the script fails if tab 2's step serves more than two bars (the forming bar and the one that just closed).
- **`credential-refresh`.** Two tabs share one token; the backend expires it (`POST /api/control {expireAccess: true}`); tab 1 is dragged back in time, the backend refuses its fetches, one tab refreshes the token for both, both stay "signed in", and tab 1's history arrives ("nothing missing"). Observed: 2 requests refused (the drag asked for two ranges, "waiting for credentials: 2 ranges"), 1 refresh, then 2 fetches of 293 bars; both tabs "signed in", tab 1 "nothing missing". Code: the fetcher throws `AuthInvalidError` on a refusal and tscache tells every tab with `authInvalid`; one tab refreshes under a Web Lock and the others adopt the new token (`reference/shared/src/auth.ts` header); the script fails unless exactly one refresh and at least one refusal happened, as `e2e/reference/clients.spec.ts` ("an expired token is refreshed once and every tab reads again") asserts.
- **`server-rendering`.** The server reads the history through tscache and renders `/ssr`; the browser's cache starts from the server's read, so the chart draws at once, and the backend serves only the newest bars to the server's read and the browser's. Observed: 721 bars drawn; the server's read and the browser's together made 2 fetches of 4 bars. Code: the server reads with an in-process client and embeds its read (`id="tscache-read"`), which the browser hydrates (`site/guides/ssr.md`; `e2e/reference/clients.spec.ts`, "the server-rendered page shows the server's read and fetches only the forming bar"). The server's in-process cache outlives requests, so the script has the server render once before the clip, as a server that has served the page before; the script fails if the clip's fetches serve more than four bars (two reads of the newest bars).
- **`live-feed-reconnect`.** The page follows the Server-Sent Events feed with one open stream; the backend drops every stream and moves its clock a minute on (`{dropStreams: true, advanceMs: 60000}`, the control the reconnect tests send); the open-stream count falls to 0 and returns to 1 after the stream's 500 ms retry; one fetch over the newest bars mends the bar the outage broke in. Observed: open streams 1, then 0, then 1; 1 fetch of 2 bars after the drop. Code: each time a source opens, every tab hears it (`onOpened`) and reads over the provisional end with a fetch, which mends the bar that was forming when the stream broke, whose final values a new stream does not send (`reference/shared/src/live.ts` header; `e2e/reference/clients.spec.ts`, "a stream that reopens a bar later mends the bar it broke in (R4-1)"). The script fails unless it saw the count at 0 and then 1, and fails if the catch-up serves more than three bars.

### Media files

| File                                                           | Duration |     Size |
| -------------------------------------------------------------- | -------: | -------: |
| `docs/media/multi-tab-sharing.gif` (720 × 450, 8 fps)          |    6.5 s | 666.4 KB |
| `site/public/media/multi-tab-sharing.mp4` (H.264, 960 × 600)   |    6.4 s | 102.0 KB |
| `site/public/media/multi-tab-sharing.webm` (VP9, 960 × 600)    |    6.4 s | 124.5 KB |
| `docs/media/credential-refresh.gif` (720 × 450, 8 fps)         |    7.4 s | 921.4 KB |
| `site/public/media/credential-refresh.mp4` (H.264, 960 × 600)  |    7.4 s | 144.1 KB |
| `site/public/media/credential-refresh.webm` (VP9, 960 × 600)   |    7.4 s | 174.3 KB |
| `docs/media/server-rendering.gif` (720 × 450, 8 fps)           |    6.0 s | 481.0 KB |
| `site/public/media/server-rendering.mp4` (H.264, 960 × 600)    |    6.0 s |  76.2 KB |
| `site/public/media/server-rendering.webm` (VP9, 960 × 600)     |    6.0 s |  97.3 KB |
| `docs/media/live-feed-reconnect.gif` (720 × 450, 8 fps)        |    5.9 s | 616.4 KB |
| `site/public/media/live-feed-reconnect.mp4` (H.264, 960 × 600) |    5.8 s | 101.0 KB |
| `site/public/media/live-feed-reconnect.webm` (VP9, 960 × 600)  |    5.8 s | 117.2 KB |

One copy of each file: the GIFs only under `docs/media/` (the README and, by absolute `raw.githubusercontent.com` URL, the npm page), the videos only under `site/public/media/` (served by the site at `/tscache/media/`).

## The site

The videos are embedded where each scenario is explained: sharing on the home page (`site/index.md`, before "A first look"), the refresh in `site/guides/auth.md` ("Refreshing once across tabs"), server rendering in `site/guides/ssr.md` (before "The server") and the reconnect in `site/guides/live-feeds.md` ("Catching up after a gap"). Each is a `<figure>` with `<video autoplay muted loop playsinline controls>`, a WebM source then an MP4 source, and a `<figcaption>` that describes what the recording shows; the video names it with `aria-describedby`. The Demo hub page (`site/guide/demo.md`) links the four and says how to make them again.

## The README

`README.md` is rewritten: six badges (CI on `main`, the npm version, npm provenance, bundle size from bundlejs, the license, the OpenSSF Scorecard), a one-paragraph pitch with one measured figure, the sharing GIF, the status, install, a short quick start, the other three GIFs, links (the Pages site, the demo benchmark table, the known limits, the architecture, roadmap, changelog, contributing and security), and the contributor sections it had (the site build, the examples, the demo hub, the framework integrations).

- **The quick start** is the package README's `src/main.ts` block, character for character, and points at the site's getting-started page for the Vite plugin and the fetcher, so the three stay one text.
- **The figure** ("36 chart views over one tab, then three": 8 backend requests for tscache, 36 for no cache, 28 for a per-tab exact-range cache) is the "Backend requests (1 tab + 3 tabs)" column of `docs/benchmarks/demo-comparison.md`, the same at all three latencies. The package README states the same figure in place of the placeholder step 67 left for this step (`docs/reviews/step-67.md`, "Left for step 65").
- **The package README** gains the sharing GIF by absolute URL (`https://raw.githubusercontent.com/anishbenji/tscache/main/docs/media/multi-tab-sharing.gif`), since npm does not serve repository-relative images; it resolves once this step is on `main`. `homepage` in `packages/tscache/package.json` is now `https://anishbenji.github.io/tscache/`.

## Contradictions found and fixed

1. The README said the demo's apps "take the next nine ports"; there are ten apps since step 67 added the benchmark (`e2e/examples/apps.ts`; the site's Demo hub page already said ten). The README now says ten and lists the benchmark in its examples table.
2. The demo hub linked the local site at `http://localhost:5173/` and `/guide/demo`, which the new base moves to `/tscache/`.
3. `docs/supply-chain.md` expected `id-token: write` in two workflows only; `pages.yml` makes three (above).

## Verification

- `bun install --frozen-lockfile`: exit 0. `bun run build`: exit 0.
- `brew install ffmpeg`: ffmpeg 9.0.2 (with libx264, libvpx-vp9 and the palette filters), a local tool on the build machine.
- `~/code/tscache-reports/bin/heavy-run.sh "65 child: record" bun scripts/demo/record.ts --reuse-builds`: exit 0, after a first full run that built every app; three full runs gave the same counts, and the committed media are the last. Its output is the observations and sizes above. Each GIF was checked by extracting frames with ffmpeg and looking at them: the captions, the counters and the pages match the observations, and the open-stream counter reads 0 for about 0.8 s in the reconnect clip.
- `ffprobe` on every file: the GIFs 720 × 450, the videos 960 × 600, the MP4s `h264`, the WebMs `vp9`; the durations in the table.
- `bun run docs:check`: exit 0, "doc-anchors: 246 anchors in 42 pages resolve".
- `bun run docs:build` with the new base: "build complete". In `site/.vitepress/dist`, no `href` or `src` that starts with `/` lies outside `/tscache/` (`grep -rhoE '(href|src)="/[^"]*"' --include='*.html'`, filtered: no match); the four pages carry `<source src="/tscache/media/<name>.webm">` and `.mp4`, and `dist/media/` holds the eight videos. A local server that serves `dist/` under `/tscache/`, as Pages does, answered every one of the 209 distinct root-relative URLs of the built pages (pages, assets, media): none missing.
- `bunx tsc -p .`: no errors (the recorder included). `bunx biome check .`: no fixes. `bun run knip`: exit 0. `bun run fallow`: exit 0, with two complexity warnings (not gating) on the recorder's `main` and `waitForHub`, which run only by hand.
- **The gate.** `~/code/tscache-reports/bin/heavy-run.sh "65 child: ci" bun run ci` on the final head; the result is in the child's report to the director.

Not verified: the workflow on GitHub (it runs only on `main`, and its deploy job needs Pages enabled, which is the director's step after merge); the badges' rendering (the npm version, provenance and bundle-size badges read the npm registry, which holds only the 0.0.1 placeholder until 0.1.0 ships, so they show the placeholder, and the provenance badge is a static label that is true once `release.yml` stages 0.1.0 with provenance); the raw GIF URL in the package README (it resolves once this branch is merged); and the site in a browser at its Pages URL. The videos were checked by extracting frames, not played in a browser page of the built site.

## Decisions

- **The stage and its iframes.** Real tabs are separate pages, and Playwright records one video per page; composing two recordings side by side and overlaying counters would need ffmpeg's text rendering and time alignment for little gain. Two same-site iframes share the app's SharedWorker as two tabs do, fit in one recording, and are disclosed as frames in every caption that shows them.
- **Counts from the backend, not the page's provenance line.** The reference page's "from cache N · from network M" line shows the latest read, which the live feed replaces within a second; the backend's counters are what each claim is checked against and what the strip shows.
- **`controls` on the videos.** The brief's `<video autoplay muted loop playsinline>` plus `controls`, so a reader can pause motion that loops for longer than five seconds (WCAG 2.2.2).
- **GIFs in `docs/media/`, videos in `site/public/media/`.** The site serves only `site/public/`, and the GIFs are not shown by the site, so each file lives once where its one reader takes it.
- **The recorder is not a `package.json` script.** It runs as `bun scripts/demo/record.ts`, like `scripts/demo-bench.ts`; adding a root script would change a protected file for a command run by hand.
