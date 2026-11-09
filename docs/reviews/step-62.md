# Step 62 review: community files

Branch `chore/62-community-files`. Spec: pre-publish plan section 62 and the user decisions of 2026-11-09 (Code of Conduct contact: GitHub private reporting plus the maintainer's GitHub profile; no email published).

## Pre-review (Claude), not the gate

Round 1 pre-review on fa65c1b: no P0 or P1, two P2.

| #   | Finding                                                                                                                                                                                                                        | Verdict | Action                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Docs links in `.github/ISSUE_TEMPLATE/config.yml`, `bug_report.yml` and `SUPPORT.md` open the VitePress sources on GitHub, where root-relative links such as `/guides/workers` resolve to `github.com/guides/workers` and 404. | Valid   | Deferred to step 65, which deploys the site to GitHub Pages: switch these links to the Pages URL there. |
| 2   | The bug form's reproduction field used `render: ts`, which wraps everything typed, including the repository link it asks for, in one TypeScript code block.                                                                    | Valid   | Fixed: `render` removed; the description asks reporters to fence their code.                            |

Decision concerns raised for the user (not acted on): the "GitHub profile" contact route has no channel today (the profile lists no contact details, and GitHub has no private messages), so the Security-tab private report is the only working route; and conduct reports would share the security advisory queue.
