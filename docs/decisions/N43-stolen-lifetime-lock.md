# N43: A stolen lifetime lock (DC-2 i, step ⑫)

Row N43 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**Same-origin scripts are inside the trust boundary**; recorded as an assumption of loss detection in §4.8 and `docs/guides/worker-setup.md`. A script that steals the lock and releases it causes false `workerLost` events, and a recovery loop then reconnects until the worker closes. Rejected: verifying with a `ping` op before declaring loss (a new op and a timeout constant, which N32 avoided; a wedged worker that still answers is called alive); a `navigator.locks.query()` check before watching (one query per connection, and a thief that holds and then releases still causes one false loss per client). User-confirmed 2026-10-23
