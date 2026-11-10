# Support

## Questions and help

Start with the documentation in [`site/`](site/):

- [Getting started](site/guide/getting-started.md)
- [Troubleshooting and FAQ](site/troubleshooting.md), which covers the common
  causes of a client falling back to a dedicated worker or to the in-process
  hosting
- the [guides](docs/guides/) for serving the worker and fetcher, and for the
  patterns tscache leaves to the application

If the documentation does not answer the question, open an issue. Describe what
you are trying to do, what you tried and what happened instead.

## Bugs and feature requests

Use the issue forms: **Bug report** or **Feature request**. A bug report needs
the browser and its version, the hosting mode (`client.mode`: `shared`,
`dedicated` or `in-process`), the package version and a minimal reproduction.

## Security problems

Do not open a public issue. Follow [`SECURITY.md`](SECURITY.md).

## What to expect

tscache is maintained by one person in their own time. Issues are usually
answered within a week. Only the latest 0.x minor release receives fixes.
