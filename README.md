# tscache

Browser time-series cache: SharedWorker multi-tab sharing, worker-side fetch
orchestration, and coverage tracking that distinguishes "not fetched yet" from
"confirmed empty" (weekends, sensor dropouts).

**Status: pre-release, under active development.** The design is settled — see
[`docs/architecture.md`](docs/architecture.md) for the API surface, RPC
protocol, and decision register. Implementation is proceeding through the
commit plan described there.

## Examples

Runnable apps under [`examples/`](examples/), each a narrative page on the
design decision it demonstrates. They share a synthetic backend
([`examples/mock-backend`](examples/mock-backend)) that every example's Vite
server mounts under `/api/`.

| App | Scenario |
|---|---|
| [`vanilla-uplot`](examples/vanilla-uplot) | Live server metrics with a volatile tail; sparse event counts |
| [`solid-uplot`](examples/solid-uplot) | IoT sensor with dropout gaps and an integer field |
| [`solid-lwcharts`](examples/solid-lwcharts) | OHLCV scroll-back over nights and weekends |
| [`react-lwcharts`](examples/react-lwcharts) | Two tabs, one SharedWorker; token refresh across tabs |

```sh
bun install && bun run build
bun run --cwd examples/vanilla-uplot dev
```

## License

[MIT](LICENSE)
