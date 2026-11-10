# Changelog

All notable changes to `@anishbenji/tscache`. The package follows semantic
versioning within 0.x: a minor release may break the API, a patch release never
does.

## [0.1.0] - 2026-11-09

The first release. A browser cache for timestamp-aligned time series, built
for charts that scroll through history and follow a live tail in several tabs.

- **Hosting.** `createClient` runs the cache in a `SharedWorker` that every
  same-origin tab shares, and falls back to a dedicated `Worker`, then to the
  page itself. A lost SharedWorker is detected with a lifetime Web Lock and
  reported as `workerLost`.
- **Fetching in the worker.** A fetcher module, loaded by the worker, fetches
  only the ranges the cache neither holds nor already has in flight, widened by one
  interval where a miss meets cached data so the series joins up (that edge
  point is fetched again). Under the
  SharedWorker hosting, concurrent reads of a range from several tabs wait on
  one fetch, and finalized history one tab fetched is not fetched again for
  another; the dedicated and in-process fallbacks give each tab a cache of its
  own. Points at or after the `finalizedUntil` watermark are provisional and
  fetched again by every read that includes them. An `AuthInvalidError` from
  the fetcher reaches every tab the worker serves as `authInvalid`, and
  `updateAuth` retries with new credentials.
- **Coverage.** A read returns the present points as one typed array per
  field, the ranges the cache knows for certain, and each missing range with
  its reason. A confirmed gap (a weekend, a sensor dropout) is never fetched
  again.
- **Freshness.** A watermark keeps the provisional tail refetched, a dataset
  version change clears a cache, and `invalidate` and `clear` forget data on
  the application's clock.
- **Writes and snapshots.** `put` adds points from a live feed;
  `encodeSnapshot`, `decodeSnapshot` and `hydrate` carry a server's read into
  the browser's cache.
- **Persistence.** `persist: true` keeps a cache's history in IndexedDB when
  the SharedWorker hosts it.
- **Entries.** `@anishbenji/tscache` (the page), `/worker`, `/fetcher`,
  `/engine` (the engine without a worker, for Node and tests) and `/vite`
  (the `fetcherUrl()` plugin for Vite 8).

The commits since the start of the project follow.

### 🚀 Features

- Add public type surface and error taxonomy
- Add cache config validation
- Add grid module for ms-slot conversion
- Add coverage index
- Add DenseSegment and the segment payload codec
- _(grid)_ Snap a put range inward to the grid
- _(engine)_ Validate put batches and convert them to slot terms
- _(engine)_ Segment store with K-gap and page layout
- _(engine)_ Read path with coverage and uncached misses
- _(engine)_ Per-cache state with watermark, invalidate, clear and version
- _(engine)_ Bound a response's authority by its own watermark
- _(engine)_ Assemble the in-process engine
- _(rpc)_ Protocol, handshake, worker-side server and port client
- _(client)_ CreateClient with the fallback chain, cache handles and SharedWorker hosting
- _(orchestrator)_ Fetcher loading, deduplicated fetches, auth state and version fence
- _(client)_ Detect loss of the SharedWorker with a lifetime lock
- _(orchestrator)_ Name the refused context in authInvalid
- _(examples)_ Add the shared mock backend
- _(examples)_ Vanilla + uPlot live metrics and sparse events
- _(examples)_ Solid-uplot sensor with dropout gaps
- _(examples)_ Solid-lwcharts candles with weekend gaps
- _(examples)_ React-lwcharts multi-tab and auth demo
- _(examples)_ Server rendering support in the mock backend
- _(examples)_ React-ssr, server-rendered candles
- _(examples)_ Solid-ssr, server-rendered sensor
- _(integrations)_ Shared client lifecycle, hydration and vanilla snippet
- _(integrations)_ Snippet for React 19
- _(integrations)_ Snippet for Solid 2.0
- _(integrations)_ Snippet for Vue 3.5
- _(integrations)_ Snippet for Svelte 5
- _(integrations)_ Snippet for Angular 22
- _(engine)_ Snapshot and hydrate with json encoders
- _(rpc)_ Hydrate op, snapshot transfer and cachehandle.hydrate
- _(examples)_ Hydrate the ssr examples from a snapshot
- _(integrations)_ Seed every client from the read's snapshot
- _(vite)_ Tscache/vite entry with fetcherUrl()
- _(vite)_ Fail the build when the fetcher uses import()
- _(examples)_ Live stream, crypto market and service token
- _(integrations)_ Read from the cache alone, and server context
- _(reference)_ Vanilla reference client
- _(reference)_ React reference client
- _(reference)_ The solid reference client
- _(examples)_ A live websocket on the mock backend
- _(reference)_ Websocket and polling feeds
- _(reference)_ Decide when an answer only adds the newest bars
- _(orchestrator)_ Subtract in-flight fetches from a get's misses (N31)
- _(bench)_ Gate timing per case from bench/gated.json
- _(bench)_ Let a case ask calibration to slow it by repetition
- _(examples)_ Serve and fetch series pages as binary columns
- _(engine)_ Persist flag, change reporting and restore
- _(persist)_ The IndexedDB store adapter
- _(persist)_ The persister, write-behind and the clearall barrier
- _(worker)_ Persistence in the SharedWorker hosting
- _(orchestrator)_ Re-plan once when the cache was cleared while a get waited
- _(client)_ Load the in-process hosting with import()
- _(persist)_ ClearAll empties the disk from the dedicated and in-process hostings
- _(vite)_ Warn at build time when workers build as iife
- _(persist)_ Stop a cache at once when a write exceeds the quota
- _(client)_ Create the SharedWorker with extendedLifetime

### 🐛 Bug Fixes

- Match guarded commands in command position only
- Type the auth-invalid marker as its literal
- Accept any integer alignmentOffset
- Fail closed on hook-bypass flags behind wrappers
- Close guard parser differentials
- Keep alignmentOffset normalization exact near 2^53
- Ignore backticks inside single quotes in the guard
- Tokenize commands in the Bash guard
- Reject non-object configs and fields with ConfigError
- Parse redirections, ANSI-C strings and options in the guard
- Fail closed on dynamic input in the Bash guard
- Match guard text triggers against the whole command line
- Close fail-open gaps in guard text triggers
- Keep env -S argument boundaries and truncate $'' at NUL
- Close guard config-read and bun x/run escapes
- Skip option values when finding guard subcommands
- Close literal guard gaps from review round A2
- Split env -S values like env does
- Keep msOf exact for negative slots near -2^53
- Restrict timestamps and slots to safe integers
- Reject non-number range endpoints in snapOut
- Treat prototype-named fields as ordinary own fields
- Allocate segment buffers before mutating in mergeFrom
- Bound segmentSlotCap at 2^31 - 1
- Bound replacement scans and check batch field names exactly
- Fill every new segment buffer before installing any
- _(engine)_ Keep the segment list sound when a put fails part-way
- _(engine)_ Make a segment join atomic and array checks realm-independent
- _(engine)_ Reject a symbol batch with PutError
- Build error messages without calling a value's own conversion
- _(engine)_ Concatenate warning arrays without spreading
- _(engine)_ Withdraw coverage for everything a failed put touched
- _(engine)_ Export the engine entry and finish clearAll despite a throwing listener
- _(engine)_ Emit the version-mismatch clear even when the write fails
- _(engine)_ Keep the write error when a clear listener also throws
- _(rpc)_ Acknowledge dispose first, enforce handshake order, reject inherited ops
- _(rpc)_ Stable wire error names and client shutdown on port close
- _(rpc)_ Answer every request even when the error cannot be stringified
- _(rpc)_ One lifecycle path for ports on both sides
- _(rpc)_ Tell the server on dispose; de-flake the peer-close test
- _(rpc)_ Announce a controlled detach and never trust a wire error's shape
- _(rpc)_ Describe peer-supplied values safely in handshake errors
- _(rpc)_ Describe a hostile op name safely too
- _(client)_ Cancel abandoned handshakes, watch workers for fatal errors, dispose on pagehide
- _(client)_ Keep the client through a back/forward-cache hide; correct the webpack recipe
- _(rpc)_ Clean up a handshake whose signal was already aborted
- _(orchestrator)_ Module reservation, fence retry, safe flanks, warnings, auth stamp
- _(orchestrator)_ Slot-based range math, per-piece miss reasons, no joining stale-auth fetches
- _(orchestrator)_ Serialize auth updates and never join a fence-dropped fetch
- _(orchestrator)_ Answer auth-pending at once; joining context goes through the auth transition
- _(orchestrator)_ Fetches never wait for an auth transition
- _(orchestrator)_ Keep updateAuth inert until a fetcher is configured
- _(orchestrator)_ Auth updates wait for a pending first import; failed loads leave no context
- _(orchestrator)_ Private fetch range, release waiters on auth loss, no fetches mid-transition
- _(orchestrator)_ Removable auth waiters; tighter cross-tab dedup proof
- _(orchestrator)_ Release a waiting get when auth is already invalid
- _(e2e)_ Take the refused token when authInvalid fires in the refresh snippet
- _(e2e)_ Fold authInvalid events into the recovery under way in the refresh snippet
- _(e2e)_ Make the refresh snippet live, seeded and fail-closed
- _(e2e)_ Refresh on an authInvalid without context in the refresh snippet
- _(orchestrator)_ Give the fetcher copies of the auth context
- _(examples)_ Drop a stale answer on the events page
- _(examples)_ Validate the mock backend's inputs
- _(examples)_ Check and test the examples before the package is built
- _(examples)_ Seed only the first Solid client
- _(integrations)_ Hydration keeps fields named like prototype members
- _(integrations)_ A conflicting cache config reaches the client's check
- _(integrations)_ The Svelte series keeps the latest read of a range
- _(integrations)_ The React hook keeps reads for every Suspense retry
- _(integrations)_ The React hook keys reads by the whole config
- _(integrations)_ The client alone decides which config names a cache
- _(integrations)_ Match configs in canonical form in the React hook
- _(integrations)_ The React server render finds its seed by cache id
- _(examples)_ Count only the exact unknown op as not seeded
- _(snapshot)_ Reject holes in arrays when decoding
- _(scripts)_ Kill only the own review, never report a finish as timeout
- _(scripts)_ Stop the watchdog test when scratch setup fails
- _(vite)_ Dev urls under the base, and tscache bundled in dev ssr
- _(vite)_ Encode dev urls and keep paths out of virtual ids
- _(vite)_ Encode server file urls, state the preload limit
- _(ci)_ Build the package before knip
- _(hooks)_ Build the package before pre-push knip
- _(typecheck)_ Check e2e and the mock backend against the source
- _(reference)_ Refill after a clear, keep the view, show what is missing
- _(reference)_ Empty answers, the opening view, and a restored session
- _(reference)_ Read through a gap in the live stream
- _(reference)_ Catch up with a fetch each time the stream opens
- _(reference)_ Remove the page's control listeners on teardown
- _(reference)_ Nothing touches a torn-down page
- _(reference)_ Keep following while a chart loads; end the page
- _(reference)_ A replaced chart keeps following as bars arrive
- _(reference)_ Retry own failed polls, resume a socket on sign-in, keep wss
- _(reference)_ A late storage event cannot restore an older feed
- _(bench)_ Merge resolutions, paths with spaces, noisy runs, round bounds
- _(bench)_ A trailer stands while the head's source is its own merge
- _(bench)_ Uncommitted source voids every trailer
- _(bench)_ Trailer tests run git without the hook's GIT_DIR
- _(ci)_ Upload the hidden bench results directory
- _(reference)_ End each poll on the bar forming now
- _(claude)_ Ask on any push naming main, drop the colon rule
- _(claude)_ Ask on pushes with no refspec or of HEAD
- _(client)_ Print put merge warnings in development builds
- _(client)_ Print orchestrated-fetch merge warnings in development builds
- _(examples)_ Keep mock fetcher fields named like prototype members
- _(ci)_ Generate the api reference before fallow reads the site config
- _(bench)_ Size sampler batches from undisturbed timings, test it on a virtual clock
- _(orchestrator)_ Plan fetches in linear sweeps
- _(reference)_ End reads and catch-ups on the bar forming now
- _(demo)_ Stop the app servers when the hub fails to start
- _(demo)_ Stop every subprocess through one shutdown
- _(demo)_ Retire a process group as soon as it is empty
- _(orchestrator)_ Decide a synchronously throwing fetch after a turn
- _(orchestrator)_ Read in the step a get's last round ends
- _(test)_ Stop the flake hunt on an unknown base
- _(test)_ Stop the flake hunt when it would run no test
- _(test)_ Validate every flake-hunt input up front, and fail a hunt that ran nothing
- _(examples)_ Refuse mixed page dtypes and match media types loosely
- _(examples)_ Compare page schemas structurally and copy unaligned buffers
- _(examples)_ Join pages by normalizing them, then one widening rule
- _(examples)_ Check each json page's column lengths before joining
- _(persist)_ Keep a failed request's abort, clone write inputs at the call
- _(persist)_ A flush attempt takes its state before it awaits the store
- _(size)_ Fail on a measured row without a committed budget
- _(size)_ Derive budgets only on an explicit update
- _(persist)_ No clear-only disk call after the deadline, connection closed at it
- _(persist)_ One owner of the clear-only deadline, answer after the close
- _(persist)_ A failed chunk import clears the clear-only import timer
- _(vite)_ Warn about an iife worker once, for the browser build only

### 💼 Other

- _(site)_ Add the documentation site
- _(site)_ Run the code examples in ci, not only type-check them
- _(site)_ Run every snippet in the docs check, behind page shims
- Set the package version to 0.1.0 and its node engines

### 🚜 Refactor

- Limit the Bash guard to literal commands
- _(segment)_ Share the programming-error checks
- _(engine)_ Split meta validation into small helpers
- _(engine)_ Move the failed-write recovery out of put
- _(rpc)_ Dispatch through a handler map and simplify the scope check
- _(rpc)_ Rebuild wire errors from a table
- _(rpc)_ Split wire-error normalization
- _(client)_ Split option resolution into helpers
- _(integrations)_ Server reader shared by every snippet
- _(examples)_ Load the fetcher with tscache/vite
- _(reference)_ Move the page's logic into a shared session
- _(segment)_ Split DenseSegment.slice into span and gather helpers
- _(bench)_ Share the round summary and add an async sampler
- _(persist)_ Smaller units under the complexity gate
- _(orchestrator)_ Read the clear generation through one helper
- _(engine)_ Restore outside the cache module
- _(scripts)_ Rename the demo error helper to describeError
- Keep the library version beside the protocol version

### 📚 Documentation

- Add starter prompt and repo seed
- Project working rules
- Consolidated architecture (signed off)
- Make one-time setup steps exact
- Document the automated review loop
- Add settle, convergence and branch rules to the review loop
- Freeze the Bash guard as a tripwire
- Specify the grid and coverage internal contracts
- Pin exact alignment and range ownership in the grid contract
- Specify the segment internal contract and put removal
- Pin the decoder's open cases in the segment contract
- _(architecture)_ Put-path contracts and decisions N13-N15
- _(architecture)_ Read-path contract and decision N16
- _(architecture)_ Per-cache state contract and decisions N17-N18
- _(architecture)_ Engine assembly contract and decisions N20-N22
- _(workflow)_ Raise the review-loop cap to ten rounds
- _(architecture)_ Rpc layer contract and decisions N23-N24
- _(architecture)_ Client and hosting contract, decisions N25-N27
- Record N28 (tab death without pagehide)
- _(architecture)_ Orchestration contract, decisions N29-N31, fetcher obligations
- _(architecture)_ Worker loss (N32) and refused context (N33)
- Serve the fetcher module under Vite; list the examples
- Start the roadmap with reference clients
- Server rendering in the worker setup guide, SSR examples listed
- _(examples)_ What a seed's range adds, in the react-ssr README
- _(roadmap)_ Persistence, subscription and eviction sketches
- _(guides)_ Consumer patterns
- _(types)_ Integer fields cannot mark a missing value
- _(integrations)_ Index of the snippets, and the README's section
- _(integrations)_ A seed's coverage check and put are not atomic
- _(architecture)_ Record the review decisions n34-n44
- _(guides)_ State what the refresh snippet and loss detection assume
- _(architecture)_ Snapshot api text for step 15
- _(architecture)_ Snapshot api text approved
- _(architecture)_ Pin snapshot range alignment and decode scope
- _(guides)_ Server rendering with snapshots
- _(guides)_ FetcherUrl from tscache/vite
- _(vite)_ Correct the preload workaround for the fetcher
- _(guide)_ Build a fetcher that needs import() on its own
- _(guide)_ Fixed fetcher name, base url and no public copy
- _(guide)_ Resolve the prebuilt fetcher url against the page
- _(guide)_ Absolute paths only for the prebuilt fetcher
- _(bench)_ The end-to-end scenarios, their method and results
- _(bench)_ Log the first calibration on the GitHub runner
- _(bench)_ Log the recalibration after step 22
- _(bench)_ Record the chromium noise experiment
- _(integrations)_ Seeds go through hydrate, which checks the version
- _(roadmap)_ The snapshot API is built, not planned
- _(api)_ Name the package entries for the generated reference
- Link the documentation site from the readme
- _(site)_ Give the browser snapshot example a fetcher and the old-worker fallback
- _(site)_ Collect the fetcher example's fields in a prototype-free object
- _(site)_ Say why the grid example's client has no fetcher
- _(site)_ Give the server snapshot example the backend's origin
- _(site)_ Listen for the backend's named bar events in the live example
- _(architecture)_ Specify indexeddb persistence
- _(architecture)_ Redesign the persistence concurrency core
- _(architecture)_ Close the round 3 edges of the persistence core
- _(reference)_ Live bars drawn incrementally, step 41 evidence
- _(architecture)_ In-flight subtraction design (N31, N62-N65)
- Describe in-flight subtraction and the fetcher's request bound
- _(bench)_ Chore 43 calibration, per-case gate rules and evidence
- _(demo)_ Crash the worker's tab to show workerLost, not close it
- _(site)_ Add a demo hub page, and link the site from the hub
- _(bench)_ Chore 45 calibration, chromium stays report-only
- Add the testing rules and their review checklist items
- _(site)_ Explain binary pages in the fetcher guide
- _(architecture)_ Narrow persistence to sharedworker hosting
- _(architecture)_ Note sharedworker-only persist in config docs
- _(bench)_ Current entry sizes in the measurement table
- _(architecture)_ No persisted load during a pending clearall
- _(architecture)_ Clearall as a writer barrier
- Persistence across sessions
- _(architecture)_ N29 re-plans once after a clear while a get waits
- _(site)_ A get asks once more after a clear, not only a drop
- Persistence loaded lazily
- The in-process hosting loaded lazily
- _(architecture)_ ClearAll empties the disk from every hosting (N66)
- ClearAll empties the persisted records from a client of any hosting
- Clear-only deadline owner, and the database a clear creates without databases()
- _(site)_ Show worker.format 'es' in the vite config snippet
- _(vite)_ Say the plugin warns about an iife worker build
- _(site)_ Add a logger filter for the iife worker warning
- _(vite)_ Show how to silence the iife warning on purpose
- CustomLogger replaces logLevel and clearScreen; the warning's opening words in architecture
- The quota stop and the extended lifetime as shipped
- ExtendedLifetime at a fixed worker url, and the lingering worker after a deploy
- Record publishing under the @anishbenji scope
- Point the copy recipes at the scoped install path
- Add the npm readme and license, and the 0.x stability note
- Draft the 0.1.0 release notes
- Limit the fetch-sharing claims to the SharedWorker and finalized history

### ⚡ Performance

- _(segment)_ Copy fully present spans in DenseSegment.slice
- _(put)_ No views or Set for a put that fits one segment
- _(segment)_ Index the loops over typed arrays
- _(read)_ Copy each point once across segments
- _(orchestrator)_ Read the engine once per get
- _(snapshot)_ Encode with native base64 where available
- _(reference)_ Draw a live bar by the newest bars only
- _(bench)_ The reload-first-read end-to-end scenario
- _(worker)_ Load persistence only when a cache persists
- _(bench)_ E2e revisions split into chunks, as tsdown emits them
- _(bench)_ E2e revisions split into chunks, as tsdown emits them

### 🎨 Styling

- Apply biome 2.6.4 formatting to markdown and yaml

### 🧪 Testing

- Type-check test files with tsc
- Replace deprecated toThrowError with toThrow
- _(engine)_ Pin schema-shaped empty reads and covered gaps
- _(engine)_ Pin failed-write withdrawal and advancing-watermark warnings
- _(e2e)_ Hold the fixture fetch so the cross-tab dedup spec needs in-flight dedup
- _(e2e)_ Use an optional chain in the fixture
- Tighten the cross-tab dedup proof and pin that gets leave no auth waiters
- _(e2e)_ Add a gated mock backend and prove dedup against it
- _(e2e)_ Cover version-mismatch clear propagation across tabs
- _(e2e)_ Cover authInvalid across tabs and a Web Locks refresh snippet
- _(e2e)_ Cover a tab dying mid-fetch
- _(examples)_ The fetcher keeps the earliest watermark of its pages
- _(examples)_ Judge react-ssr by the backend's provisional day
- _(integrations)_ Type the prototype-name hydration test
- _(e2e)_ Cover the port offset, and accept only digits as an override
- _(put)_ Pin the put path's field checks and copies
- _(bench)_ Make the calibration stalls fire, and check that they did
- _(bench)_ Add the live-tail-get end-to-end scenario
- _(bench)_ Make each live-tail-get operation prove a fetch
- _(reference)_ Check what each chart view hands its library (R1-1)
- _(e2e)_ Have the server render once before the new server-rendered test
- _(orchestrator)_ Assert T14's documented error, not its wording
- _(bench)_ Slow read-year by repetition in calibration
- _(e2e)_ Open every page of the demo hub and check it draws data
- _(e2e)_ Cover the hub's other controls and its refusals
- _(e2e)_ Spawn the demo launcher by its absolute path
- _(e2e)_ Give the expired token until the page's next poll
- _(e2e)_ Run the demo's shared-state tests one at a time
- _(e2e)_ Make the launcher spec's fallback cleanup find its servers
- Wait for conditions, not for time, in the unit tests
- _(e2e)_ Pin clocks and wait for answers in the reference spec
- Wait for the warning events in the dev-warnings tests
- Return Vitest to its default 5 s timeout
- Make the dedup test's two gets overlap again
- Hold the late hello behind a gate, not a longer timer
- _(e2e)_ Let the test timeout bound the worker-alive check
- _(e2e)_ Use the shared server warm-up in fix 31's server-rendered test
- _(e2e)_ Let the test timeout bound the demo launcher's exit
- _(e2e)_ Fetch the fixture's candles as binary columns
- _(perf)_ Exact persistence budgets
- _(e2e)_ Persistence across a reload in shared mode
- _(vite)_ The worker entry under ?worker&url in both worker formats
- _(e2e)_ Read the hosting mode in step 52's test names correctly
- Check slice-into reads without typed-array deep equality
- _(e2e)_ The SharedWorker outlives its last tab and its final flush lands
- Alias the scoped specifiers to the source in vitest

### ⚙️ Miscellaneous Tasks

- Scaffold bun workspaces and package skeleton
- Add biome lint and format config
- Wire lefthook, gitleaks, and commitlint hooks
- Add tsdown build with publint and attw checks
- Add vitest and playwright test scaffolding
- Add knip, fallow audit, git-cliff, and bun run ci
- Add agent workflow, review checklist and Claude/Codex config
- Pin fallow as a devDependency
- Add headless Codex review script
- Re-run commit-time checks over the branch range
- Scan merge diffs in the gitleaks backstop
- Retry Codex reviews on model-capacity errors
- Run the quality gate on GitHub Actions
- Bump patch and minor dev dependencies
- Let Dependabot propose major bumps on their own
- Bump Vitest to 5
- Bump tsdown to 0.23
- _(fallow)_ Report unused class members without gating
- _(fallow)_ Report unused class members without gating
- Install Chromium for the Playwright suite
- _(e2e)_ Serve the built package to the Playwright suite
- Install dependencies before resolving the Playwright binary
- _(e2e)_ Format the static server
- _(e2e)_ Register scripts as Fallow entries and split the server handler
- _(e2e)_ Add a readiness probe for Playwright's webServer
- _(scripts)_ Commit the review watchdog, pin the audit base
- _(commitlint)_ Skip dependabot's capitalised bump commits
- _(test)_ Raise vitest's test timeout to 20 s
- _(typecheck)_ Type-check e2e, scripts and tool configs
- _(ci)_ Start local ci without the built package
- _(hooks)_ Type-check the integration snippets before push
- _(bench)_ Performance budgets and a paired timing gate
- _(bench)_ Chromium end-to-end scenarios, report-only
- _(bench)_ Report the end-to-end scenarios in the bench job
- _(bench)_ Bound the end-to-end step below the job timeout
- _(e2e)_ Give each checkout its own playwright ports
- _(e2e)_ Keep hashed port offsets off zero
- _(claude)_ Narrow the permission ask rules
- _(claude)_ Ask before pushes that force, delete or reach main
- _(bench)_ Add setups for the chromium noise experiment
- _(bench)_ Time compare with 100 ms batches and 30 rounds
- _(bench)_ Gate eight bun cases that calibration shows reliable
- _(demo)_ Serve every example and reference client from one hub
- _(test)_ Add a flake hunt, locally and as a manual or weekly workflow
- _(test)_ Fail ci on wall clocks, self-timing and sleeps in tests
- Bump actions/setup-node from 7.0.0 to 7.1.0 in the actions group
- _(dependabot)_ Group react and solid packages that must move together
- _(examples)_ Build the tscache worker as an ES module
- Bump the solid group with 2 updates
- Rename the package to @anishbenji/tscache
- _(package)_ Add repository links and public access
- Check the packed contents against an allowlist
- Generate the 0.1.0 changelog with git-cliff
- Keep a blank line before the next release in a prepended changelog

### ◀️ Revert

- _(bench)_ Keep the wait in read-year's injected slowdown
