# tscache

Browser time-series cache: SharedWorker multi-tab sharing, worker-side fetch
orchestration, and coverage tracking that distinguishes "not fetched yet" from
"confirmed empty" (weekends, sensor dropouts).

**Status: pre-release, under active development.** The design is settled — see
[`docs/architecture.md`](docs/architecture.md) for the API surface, RPC
protocol, and decision register. Implementation is proceeding through the
commit plan described there.

## License

[MIT](LICENSE)
