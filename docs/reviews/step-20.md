# Step 20 — Reference clients: WebSocket and polling feeds

Branch: `feat/20-feed-transports` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: in review · Verdict after triage: —

The feed variants the user asked to follow the three reference clients (`docs/roadmap.md`, "Reference clients"; decisions of 2026-10-26). Not an engine step: tests are written with the code.

## Scope

| Commit | What |
|---|---|
| c68fbfa | `feat(examples)`: the mock backend pushes the live batches on a WebSocket (`/api/live`) as well as over SSE, from one push loop; a socket subscribes with its first message, token included, and is closed with 4401 (refused token), 4400 (bad subscription) or 1012 (`dropStreams`); the Vite plugin hands the upgrades to `ws`; README |
| dd47673 | `feat(reference)`: `liveFeed` takes a source (`eventSource`, `webSocket`, `polling`); the session holds the feed in its state and switches it; `feed.ts` stores the choice for every tab; `auth.ts` shares its locked refresh with the socket; a Feed menu in each client; E2E tests; README and roadmap |

## Decisions made in the step

The first four are the user's (2026-10-26); the rest are mine.

| # | Decision | Why | Alternatives |
|---|---|---|---|
| D1 | Polling is a fetching cache read of the time since the last poll | The case for polling is a backend without a push API. tscache fetches only what it lacks in the span, the provisional end, so a poll costs one small fetch and needs no endpoint | Poll a batch endpoint (`?since=`) and put its answer, as the pushing sources do |
| D2 | The socket server is `ws` under Node | Vite runs under Node, where `Bun.serve` (asked about first) does not exist; `ws` keeps the socket in Vite's process, beside the backend's clock, tokens and controls | A Bun-hosted backend behind Vite's proxy; Vite under Bun; a hand-written RFC 6455 server |
| D3 | The socket presents the access token in its first message; a refused one closes it with 4401 | A browser's WebSocket sends no authorization header; the first message carries the token and the subscription, which shows what a socket adds over SSE | An unauthenticated socket, as the event stream is |
| D4 | A Feed menu and `?feed=` on every page, switching live | As the chart menu | The feed fixed per page load |
| D5 | `ws` is typed by a local declaration (`node.d.ts`), not `@types/ws` | `@types/ws` brings Node's type definitions, which the examples avoid; the plugin uses four members of `ws` | `@types/ws` as a second dev dependency |
| D6 | `liveFeed` takes a source, and a tab applies whatever the holder passes on, whichever source the holder runs | Election, the channel, and putting or redrawing are the same for every source; a source only reports openings and new bars. A tab never has to agree with the holder on the source, only on the hosting mode, as before | One feed module per transport, each with its own election |
| D7 | Every tab of the origin takes the latest choice, stored in `localStorage`; a `?feed=` in a URL is rewritten to it, and a URL without one is left | One tab holds the feed for all, so the tabs must agree on it. The storage event tells the others, as for tokens (`onTokensStored`). A stale `?feed=` would make an older choice everyone's again on a reload | A per-tab choice where the holder's source wins, which the menu of a non-holding tab would misstate |
| D8 | The socket reports its opening on the subscription's first batch, not on the `open` event | The backend checks the token after `open`; counting `open` would make every tab catch up with a fetch for a socket the backend then refuses | An acknowledgement message from the backend |
| D9 | A poll moves on only when it is complete (no failed or auth-pending fetch) | Otherwise a failed poll's span would never be read again by the feed | Always move on, and leave the gap to the next scroll or opening |
| D10 | The WebSocket and polling tests run against the vanilla client; the feed switch runs against all three | What the page does with new bars is in `reference/shared`; a client only adds the menu | Every feed test against every client (three times the run) |

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | A tab on a cache of its own that fails its read of a poll never reads that span again | accepted | Validated by reading `apply`: the follower read the holder's span only, and the holder had moved on. Each tab now keeps where its own reads stopped being complete and reads the next poll from there (D9's rule, applied to every tab). Unit test (`reference/shared/test/live.test.ts`, under Node, which has Web Locks and BroadcastChannel): a dedicated-worker tab fails one poll and reads it again with the next; fails with the fix removed. b4ca6a4 |
| R1-2 | P1 | A socket waiting after a lost session never restarts when the user signs in in the same tab | accepted | Validated by reading: the wait listened for the storage event only, which a tab does not receive for its own writes. The session now also resumes waiting sockets when its own sign-in succeeds, and the socket's retry runs once however it hears of the sign-in. E2E test: spoil the refresh token, refuse the socket's token, see "signed out" and no socket, sign in, and see the socket back and drawing; fails with the resume removed. b4ca6a4 |
| R1-3 | P1 | An absolute `wss:` socket URL is rewritten to `ws:` | accepted | Validated by reading. `socketAddress` converts only `http:` and `https:`; unit test with relative, `ws:` and `wss:` URLs; fails with the old conversion. b4ca6a4 |

## Verification

- `bunx vitest run`: 1470 passed, with three new socket tests of the mock backend (subscription and pushes, refused tokens, bad subscriptions and `dropStreams`).
- `E2E_EXAMPLES=reference-vanilla bunx playwright test --project=examples reference/ -g reference-vanilla`: 20 passed, including the switch, two WebSocket tests (hand-over, mending after a reconnect), the refused-token reconnect and polling.
- Mutation checks, each failing its test: a non-holding tab that also reads each poll (six fetches against at most three), a socket that reconnects after 4401 without refreshing, a tab that ignores another tab's choice.
- By hand against the dev server: a current token streams on `/api/live`, a stale one is closed with 4401, and Vite's HMR socket still connects.
- Not verified: Firefox and Safari; the feeds on dedicated-worker or in-process tabs; a socket behind a proxy that drops idle connections (the backend sends a batch every second).
