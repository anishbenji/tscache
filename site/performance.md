# Performance

tscache is meant to be fast at what a chart does: read the screen it shows, take new bars as they
arrive, and scroll back through history, in several tabs sharing one worker. The full method, every
measurement and the gate are in
[`docs/benchmarking.md`](https://github.com/anishbenji/tscache/blob/main/docs/benchmarking.md); this page
summarises them.

## What it costs

- **Memory:** a bar costs its fields' bytes plus one presence bit; timestamps are implicit. A year of
  one-minute bars, put day by day, keeps about 36.2 bytes per bar for 36 bytes of fields.
- **Port:** a cached read of 1,500 bars is one message each way and moves 66,000 bytes (8 bytes of
  timestamp and 36 of fields per bar). The worker copies the slice out of the cache once and transfers
  that copy; nothing is copied a second time.
- **Backend:** a chart's opening read and twelve screens of scrolling back cost 13 fetches, covering at
  most 0.2 % more than was read, and scrolling forward again costs none.
- **Lookups:** a read among 8,192 single-point segments looks at 14 of them; a scan would read all.

These are exact budgets: they count rather than time, and a pull request that exceeds one fails. So
does one that grows an entry past its compressed size budget: `tscache` is about 13.7 kB,
`tscache/worker` 11.1 kB, `tscache/engine` 8.8 kB, `tscache/fetcher` 0.14 kB and `tscache/vite`
0.95 kB (Brotli, minified, measured 2026-10-26).

## How fast

Timed on an Apple Silicon Mac, as an example of scale; the gate compares ratios between revisions,
never these numbers:

| Operation | Chromium | Bun |
|---|---:|---:|
| read 1,500 bars from a year of 24/7 bars | 30 µs | 90 µs |
| put a 5,000-bar page over cached history | 210 µs | 740 µs |
| put the newest bar again, as a pushed update | 3 µs | 2 µs |
| read the whole year (525,600 bars) | 8.9 ms | 30 ms |

End to end in Chromium, a new tab's first read (worker start, handshake, the fetcher's import, one
fetch) took about 7.5 ms, a cached read of 1,500 bars through a SharedWorker about 33 µs, and two tabs
asking for the same new range at once shared one fetch in about 0.4 ms.

Later optimisations, such as the read fast path of step 22, are recorded with their measured ratios in
the benchmarking document.

## How it is checked

- Exact budgets (sizes, memory, fetch counts, port traffic, segment lookups, allocation growth) gate
  every pull request.
- Timings compare a pull request with its base, interleaved in one process, in Chromium (V8) and Bun
  (JSC, the engine of Safari), with a same-revision control. They report only until they are calibrated
  on GitHub's runner; then a confirmed slowdown of 10 % or more fails.
- End-to-end scenarios through a real SharedWorker report timings, and fail on a wrong result or an
  extra fetch.

```sh
bun run size          # entry sizes against their budgets
bun run bench:smoke   # every case once, results checked
bun run bench         # the working tree against origin/main, Chromium and Bun
```

## Tips

- Read the screen plus a screen on each side: short scrolls are then answered from the cache.
- Have the backend send pages as binary columns rather than JSON ([Binary pages](/guides/fetcher#binary-pages)):
  a 5,000-bar page decodes in about 93 µs instead of 443 µs as columnar JSON, in the worker, for every
  tab.
- Pick the smallest dtype that holds the data: `f32` halves a field's memory and port traffic against
  `f64`.
- Leave `warnOnOverlapDiff` off unless you need it: it compares every overlapping write.
- Share one client per page and one cache per series; a SharedWorker then serves every tab.
