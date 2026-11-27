# Paused

The owner asked to pause on 2026-11-27, while four workers were still building. They were
stopped. Everything that was finished is merged and pushed. What was unfinished is here, as one
patch per worker, so it survives the container being reclaimed. None of it is reviewed, and its
gates were not run: it is a head start for the worker that takes the task up again, nothing more.

| Patch | Task (brief) | Applies on | State when stopped |
|---|---|---|---|
| `splits-routes.patch` | `../round2/splits-routes.md` | `caef033d` | committed by the worker on its branch; its final gates and its review had not run |
| `splits-stores.patch` | `../round2/splits-stores.md` | `afc96a31` | mid-work (the erasure tests and the scrub test) |
| `web-W0.patch` | `../web/W0.md` | `caef033d` | mid-work (the module host and the build plugin exist; tests partly red) |
| `web-W1.patch` | `../web/W1.md` | `c956c04f` | early (6 files) |

To take one up again: `git checkout -b <name> <applies on>`, `git apply --index <patch>`, then
merge `ccr-b6017e12-l1bxyh` into it and give the worker the brief plus "continue from what is
there; check every file before you trust it". While this container lives, the same work is
also on the local branches `worktree-wf_75a9cb8d-d87-3`, `-4`, `worktree-wf_d0293ee6-6ca-1` and
`worktree-wf_de55ab60-dfb-1`.

Also not started when the pause came: the reviews of the two round 2 tasks that were merged
last (`module-sql-reads`, `kits-and-doubles`; the driver ran their tests, 79 files green, but no
second agent read them).

Delete this directory when the work is resumed and the patches are used or dropped.
