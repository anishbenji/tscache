# Architecture for contributors

The normative design is the
[architecture document](https://github.com/anishbenji/tscache/blob/main/docs/architecture.md): the
public API (§2), the wire protocol (§3), the module layout and the internal contracts (§4), and the
decision register (§6–§8), whose decisions are locked. This page is a map of it. How work is planned,
tested and reviewed is in [`AGENTS.md`](https://github.com/anishbenji/tscache/blob/main/AGENTS.md) and
[`docs/workflow.md`](https://github.com/anishbenji/tscache/blob/main/docs/workflow.md).

## One engine, three hostings

```
┌─ tab A ─────────┐  ┌─ tab B ─────────┐
│ client (RPC)    │  │ client (RPC)    │
└───────┬─────────┘  └────────┬────────┘
        └────── MessagePort ──┘
        ┌───────────▼────────────┐
        │ SharedWorker           │
        │  rpc server            │
        │  orchestrator ── fetcher (dynamic import)
        │  engine                │
        │   ├ coverage index     │
        │   └ segments (dense)   │
        └────────────────────────┘
```

The engine is one class. In a SharedWorker one RPC server serves every tab's port; a dedicated worker
serves one; in-process, a `MessageChannel` pair connects the client to a server in the same realm, so
the RPC layer runs on every path.

## Layers in `packages/tscache/src`

| Module | Role |
|---|---|
| `grid.ts` | every millisecond ↔ slot conversion: the one place for fencepost logic |
| `coverage.ts` | the coverage index on slot ranges: sorted, disjoint, merged, subtracted |
| `segment/` | the `Segment` interface, `DenseSegment`, and the payload format |
| `engine/` | config and batch validation, the put path (segment layout, merge), the read path, per-cache state (watermark, version), snapshots, and `Engine` |
| `orchestrator/` | the fetcher: loading, miss coalescing, in-flight dedup, the version fence, auth state |
| `rpc/` | the wire protocol, the worker-side server, the client-side port, the lifetime lock |
| `client/` | `createClient`, the fallback chain, `CacheHandle`, events |
| `entries/` | the five package entries |
| `vite/` | the `fetcherUrl()` plugin |

The dependency rule: `grid`, `coverage`, `segment/` and `engine/` import nothing from `rpc/`, `client/`
or `orchestrator/`, and touch no DOM or worker API, which keeps the engine usable in Node.

## Invariants to keep

- **Coverage is separate from data.** Absence of points inside coverage is a confirmed gap.
- **Present points only.** A read returns equal-length columns without holes, whatever the layout.
- **Never reject for availability.** Failures are misses with reasons; rejection is for programmer
  errors.
- **Reads copy, then transfer.** Cache-owned memory is never transferred; there is no
  SharedArrayBuffer.
- **One format, three uses.** The segment payload is the wire format, the future persistence record and
  the server-rendering payload.
- **The volatile region is never covered**, and a response's watermark bounds its own authority.

## Testing

Most logic runs under Vitest in Node, against the engine and over `MessageChannel`; the engine steps
were written test-first against contract tests. Playwright covers real workers: a SharedWorker shared
by pages of one browser context, the fallback chain, dedup across tabs, the auth broadcast and worker
loss. `bun run ci` runs every check; tests run with `bun run test`, under Node.

## This site

The site lives in `site/`: VitePress pages, an API reference that TypeDoc generates from the package's
TSDoc into `site/api/`, and code examples in `site/snippets/` that `bun run docs:check` type-checks
against the built package and `bun run docs:run` executes against the examples' mock backend. `bun run docs:dev` serves it; `bun run docs:build` builds it and fails on a
dead link, including a link to a repository file that does not exist.
