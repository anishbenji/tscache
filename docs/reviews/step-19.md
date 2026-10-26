# Step 19 — Reference clients: Solid

Branch: `feat/19-reference-solid` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: in review · Verdict after triage: —

The third of the three reference clients (`docs/roadmap.md`, "Reference clients"; decisions of 2026-10-26). Not an engine step: tests are written with the code. The session (`reference/shared/src/session.ts`, step 18 D1) is unchanged; this step binds it to Solid 2.0 (`solid-js` and `@solidjs/web` 2.0.0-rc.14, `vite-plugin-solid` 3.0.0-next.27, the versions the Solid examples already use).

## Scope

| Commit | What |
|---|---|
| 475b8a4 | `feat(reference)`: `reference/solid` (client-only at `/`, server-rendered at `/ssr`); the reference spec runs every test against all three clients; Knip, README and roadmap |

## Decisions made in the step

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | The session's state reaches Solid as one signal, replaced on each change, with a memo for the answer | The state is an immutable object the session replaces; a signal holds it as it is. Each text expression updates on its own, and the memo keeps the chart's drawing effect from running for changes that leave the answer as it was (the connection, the auth status) | A store: it would wrap the answer in proxies, hand those to the chart libraries, and reconcile the whole answer on every push |
| D2 | The chart library is an async memo of the chart kind, and the view is created by an effect that reads it | Effects wait for an async value to settle, so the chart on screen stays until the next library has loaded and is then replaced in one step, as the vanilla page does. The React client's effect cleanup detaches the old chart before the import resolves and relies on the session's `detached` state (step 18 R1-1, R2-1); here that state is used only for the instant between dispose and create | An effect that loads the library itself, with a cancelled flag, as React does |
| D3 | The chart creates the same computations on the server as in the browser | Solid matches server markup to the browser's render by hydration keys taken from the owner tree. A chart that created its computations only when it had a session shifted every key after it, and the browser built a detached chart element (found by the server-rendered page's test: no canvas). The computations now exist on both sides, and do nothing on the server | Render the chart element outside the hydrated tree |
| D4 | The chart menu marks its option `selected`, not the select's `value` | `selected` is an attribute the server writes too, so the server-rendered page shows the library `?chart=` asked for before it hydrates | A `value` on the select, which is a property only |
| D5 | No `Loading` or `Errored` boundary | Nothing the page renders reads an async value: the state always has something to show (the server's read, or "loading…"), and only the chart's effects read the library. A library that fails to load is logged by the effect, as the vanilla page's unhandled import is | A `Loading` boundary over the chart, which would replace the chart on screen with a fallback while the next library loads |

## Verification

- `E2E_EXAMPLES=reference-solid bunx playwright test --project=examples reference/ -g reference-solid`: 15 passed.
- Run by hand in Chromium against the dev server: `/ssr?chart=uplot` hydrates with no warning (dev mode reports hydration key misses; the preview build used by the tests does not) and draws the server's read.
- Not verified: Firefox and Safari; the feed on dedicated-worker or in-process tabs; a page remount (no spec remounts a page).
