# Security policy

## Supported versions

tscache is pre-release. Security fixes land on `main` only.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub: open the repository's **Security** tab and choose **Report a
vulnerability**. You will get a reply within a week.

Reports that are especially useful for this project: a segment payload or RPC
message that makes the cache read or write outside its own buffers, and any
way for one cache's data to reach a page that should not see it.
