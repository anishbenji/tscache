# Security policy

## Supported versions

tscache follows semver for 0.x releases: a minor release may break the API,
a patch release never does. Only the latest 0.x minor receives fixes; a
security fix ships as a patch of that minor, and an older minor gets none.

| Version           | Supported             |
| ----------------- | --------------------- |
| latest 0.x minor  | Yes                   |
| older 0.x minors  | No                    |
| unreleased `main` | Fixes land here first |

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. You will get a reply within a week.

Reports that are especially useful for this project: a segment payload or RPC
message that makes the cache read or write outside its own buffers, and any
way for one cache's data to reach a page that should not see it.
