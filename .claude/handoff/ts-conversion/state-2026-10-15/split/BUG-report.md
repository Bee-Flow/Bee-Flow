Status: 44 bug issues closed (fixed on ts-bugs/fixes or the hardening branch); 7 open with a reason; #201 in its security round.
Done: 44 closed / 51 handled (158-217)
Next: #201 (caller connections) after its security fixes; owner decisions below; the automatic check picks up new and reopened issues every 30 min.

Branch `ts-bugs/fixes` (tip in `git log -1 origin/ts-bugs/fixes`), based on `origin/ccr-28820270-xkvwp8`.
One commit per issue (a few follow-up commits for reopened issues), each reviewed by a separate read-only
Opus subagent (security review for signing, scope, redaction, credentials, SQL scoping). Gates before
every push: tests next to the changed files, server + agent-hub typecheck, `check:fast`,
`duplication-ratchet`, `lint:budget`, `lint:gitleaks`. No ratchet was `--update`d.
Separate branch `ts-bugs/sec-webpage-sqlite` (on top of ts-bugs/fixes): hardening, details shared
privately; it also carries #210.

## Closed (fixed)
| # | Area | Commit(s) |
|---|---|---|
| 158 | Teams "record" mark imports with autoImport off | 4cd7286ad |
| 159 | Teams list "processing" state, 48 h deadline | fcb063b0d |
| 160 | Meeting imports follow the Azure engines | 304e39752 |
| 162 | KB legacy documents adopted into sources | e06395996 |
| 163, 165 | already fixed on the convert branch | 389d441fe; 0067e08b0, 1dd7564d7 |
| 175 | dry run: simulated paths (+ implied parents after reopen) | 90999caa9, bec6631cb |
| 177 | connector HMAC canonical query (c1 marker, backward compatible) | a65bdf059 |
| 178 | ? # % in names over the connector hop | 81c0daa91 |
| 179 | upload creates missing parents | fbed997b0 |
| 180 | Files tools (+ folder_tree missing path after reopen) | a6b657f17, 62ea9c446 |
| 181-184 | contacts, calendar (TZID kept), tasks, Deck (+ move via target-stack PUT after reopen) | 0186058f0, f092695b6, 539a8fa7d, aebfd7c39, 9483155b4 |
| 185-188 | Tables values, Notes/Forms, status, Teams add_members | ce992b2e6, 6e10abc10, 60a6efcef, eac335d06 (rebased: see git log) |
| 189, 190 | Mail (linear HTML→text), Talk/Notifications/Activity | cefe5fb21, 6a591be23 |
| 192, 194 | trigger double-fire, builder trigger warnings | 812db7763, 2067efd80 |
| 196 | org scope ceiling on MCP (fail closed) | 20d7cf433 |
| 197 | 401/403/404 mapping (+ app-specific wording after reopen) | 8be287e9c, 413cc8f5c |
| 199 | Talk room token readable via provenance | 542db0a5e |
| 202 | failed-run banner | b298fb2fb |
| 203-207 | App Studio MCP dry run, query data, set_plan, documents (allow-list), inspection | 21d1d6fa8, f9f53a7ce, 3ebc4364d, 49446fcd1, 543f0a9a1, bc76b3175, be2882b12 |
| 208, 211 | notebook tools hidden on /mcp; webpage/fireflies tools | 0c2c2d25e, 388c8c54a |
| 210 | XML-invalid chars, sheet names, deck edge cases (on the hardening branch) | 470e582ef |
| 212 | builder_read_document kept across MCP calls | dfc59defb |
| 213 | iteration caps reported (run stays success) | 64f3b4b86 |
| 214, 215 | dateAdd/dateDiff; datetime step timezone/strict dates/epoch | 7ae9f6164, 06e10499f |
| 216 | engine defects (+ len/count, builder wording) | 78a597e60, 7bc59b3b2 |
| 217 | fill_document numeric strings | ce79fdcaf |

## Open
| # | Why |
|---|---|
| 174 | owner decision (Destination host check); another branch fix/174-destination-proxy-prefix exists |
| 191 | needs a per-subscriber Nextcloud access check that does not exist yet |
| 193 | partly fixed (a9cd0b501): canonical payload, tagId by name, upcoming multi-calendar open |
| 195 | partly fixed (eddaf601f): ~100 output schemas have no source to generate from |
| 198 | no bug found on our side; three live checks requested in the issue |
| 200 | mostly fixed (1d87bc53b): knowledge_write, approval, datatable, App Studio, AI tool loop open |
| 209 | partly fixed (76811f031): edit/delete tools need a decision (memory tools reach every agent) |
| 201 | enhancement, in its security fix round (caller ∩ owner rights, starter-only run details) |

## Owner decisions pending
- #209: expose memory edit/delete tools, and to whom.
- #213: should an implicit iteration cap fail the run.
- #177 follow-up: legacy-signed requests with several query params remain swappable on a new connector (pre-existing; closing it breaks old servers' special-character queries).

Reviews: `../reviews/BUG-<issue>.md`, one per fixed issue (fixes pushed before their Opus review got a late review round, appended to the same file).
