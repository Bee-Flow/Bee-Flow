# Learning Center lesson videos: hand-over

Use this file to continue the lesson-video work with any LLM or by hand. Last updated 2026-10-03 by Claude.

## See the current status

```bash
node .claude/handoff/lesson-videos/status.mjs        # priority set: state, length, QA, what is still to do per lesson
node .claude/handoff/lesson-videos/status.mjs --all  # include the "later" lessons
node .claude/handoff/lesson-videos/status.mjs --json # machine-readable
```

The script reads only files (clip-studio outputs, `learn-videos.json`, `curriculum.json`). States:
- `done`: the final video exists and QA has 0 fails.
- `qa-fail`: built, but QA fails.
- `in-progress`: a storyboard exists, but there is no video yet.
- `todo`
- `blocked`

## Goal and decisions (keep these)

- Every Learning Center lesson where seeing it helps gets a short English video. The video plays inside the lesson as an optional step after the opening slide.
- Style:
  - Template `lesson`, theme `honey-split`: honey colours, text on the left and a framed real app screenshot on the right, with a smooth morph into and out of the live recording.
  - A **silent** title card with the subject, then the concept card with the line that says what the feature is and why it matters. Navigation and the how-to come after that.
  - Chapters, a recap, and an outro with **only the logo**. Never a tagline such as "Private AI for your team".
  - Never say "Bee Flow" in the narration.
- Voice: the local Kokoro preset **heart**, which is free. **Never ElevenLabs.** Subtitles are burned in and centred.
- Length follows the subject: 45 to 180 s. Anything over 180 s gets shortened.
- Priority order is in `data/priority.json`: Studio first (agents, knowledge, skills, routines, approvals, datatables, forms, apps, webpages, playbooks, solutions), then Compliance Center, then Privacy Shield, then the rest. `data/later.json` is optional.
- Budget: hand the mechanical work to the `lesson-run` script and the cheap model (Sonnet). Keep a lesson to about 6 lesson-run iterations, then mark it failed.

## Hard rules

- Use only the local app (http://localhost:5176) and only the demo org `honeycomb-demo-b-v`, with the demo account. No other org, no remote systems.
- **Approved:** live LLM calls with fictional prompts; creating fictional demo chats or data on camera; switching the Privacy Shield "last check" for a single take and back again (Settings › Organisation › Privacy Shield › Leaving your org). Do that under `flock <some lock file>`, so that no other recording runs at the same time.
- **Not allowed:** activating routines, making forms public, publishing anything new, sending e-mail, messages or webhooks, connecting external accounts. Show the screen without doing it.
- Do not run `demo_reset` with `force` while other recordings run. Plain `demo_reset` (it refuses while others record) is fine for items created by these runs.
- **No git commits or pushes** unless the user asks for that explicitly.
- Never read or print `.env` files, cookies or tokens.
- Personal data stays out: all on-screen data is fictional.

## Where things are

| What | Where |
|---|---|
| Clip toolkit (record, cut, voice, QA, MCP server) | `/home/tom/Projects/Bee-Flow-AI-internal/clip-studio` (not in git yet) |
| Lesson runner (the main tool) | `clip-studio`: `node bin/clip.mjs lesson-run …`, code in `src/lessonrun/` |
| Video specs (subject, the "what it is" line, concept card, chapters, beats, target length) | `data/video-specs.json` (readable: `data/video-specs.md`). lesson-run reads it by default; `CLIP_LESSON_SPEC` overrides the path |
| Per-lesson fixes | `clip-studio/drafts/lessonrun/<lessonId>.overrides.json` |
| Storyboards and scenes | `clip-studio/drafts/storyboards/lesson-<id>.yaml`, `drafts/scenes/lesson-<id>-*.json` |
| Takes / final videos | `clip-studio/out/takes/`, `out/cuts/lesson-<id>/lesson-<id>-heart-subs.mp4` (+ `.qa.json`, `.check.jpg`) |
| Media pack mapping (videoId → storyboard) | `clip-studio/learn-videos.json` → `node bin/clip.mjs learn-pack` → `out/learn-pack/` |
| Demo data that was seeded (for clean-up) | `data/seed-log/*.json`, `data/seed-status.md`, `data/seed-plan.md` |
| Lessons (source, generated) | `.claude/handoff/curriculum/` (`curriculum.json`, `lessons/*.json`, `generate.mjs`) |
| App side (already built) | video step: `agent-hub/src/components/onboarding/player/VideoStep.tsx`, `learnMedia.ts`; server: `server/learning/learnMedia.js` (`/learn-media/*` from `LEARN_MEDIA_DIR`) |

## Continue producing videos

For each lesson that `status.mjs` shows as `todo`, `in-progress` or `qa-fail`, in priority order:

```bash
cd /home/tom/Projects/Bee-Flow-AI-internal/clip-studio
node bin/clip.mjs lesson-run <lessonId> --json
```

The stages are spec → targets → values → instantiate → record → build → check. Each run resumes where the last one stopped. The exit code tells you what to do:

- **0**: done. Look at `out/cuts/lesson-<id>/lesson-<id>.check.jpg` once: silent title, concept card, zooms on the narrated element, nothing personal.
- **2**: unresolved targets or template slots. The output lists up to 5 candidates per step, each with a ready-to-paste target. Put the right one in `drafts/lessonrun/<id>.overrides.json` and rerun. Override shapes are documented in `src/lessonrun/spec.mjs`. In short:
  - `allowSideEffects` (needed when a scene types or sends something)
  - `chapters["N"]`: `drop` / `title` / `start` / `ready` / `setup` / `addBeats` / `resolveSteps`
  - `hops["N.k"]` and `beats["N.k"]`: `target` / `drop` / `say` / `do` / `text` / `key` / `waitFor` / `opens`
  - `values` (any template slot)
- **3**: QA fails. The failing checks are listed. Fix them in the overrides or the scene, then run `--from build`.
- **1**: error. Read `out/lessonrun/<id>.log`.

Batch mode, no LLM needed for lessons that resolve fully:

```bash
node bin/clip.mjs lesson-run --batch ids.json --concurrency 2
```

It writes `out/lessonrun/summary.json`.

Useful for fixing: the clip-studio MCP tools `inspect_page`, `find_page`, `test_targets` (read-only views of the app), `node bin/clip.mjs take <scene>`, and `node bin/clip.mjs preview <storyboard> --sound voice --preset heart --cols 6 --rows 5`.

### Known pitfalls

- **Privacy Shield review dialog:** "Check this before it goes to the AI" opens after a chat message is sent. A scene that sends needs a step that clicks `Send` / `Redact and send` when that heading is visible. Example: `drafts/scenes/lesson-chat-first-answer-answer.json`.
- **Chapters start fresh:** a beat that needs an answer has to ask again in that chapter (setup/resolveSteps), or it has to be merged into the previous chapter.
- **Typing inside a zoom:** use `cps: 120` instead of `fastForward`, otherwise QA fails with speed-over-beat.
- **Lessons that create agents:** each recording creates a real agent. **`creating-agents` is blocked**: 8 extra "Supplier Contract(s) Assistant" agents from earlier runs hit the agent limit. When no other recording runs, delete exactly those with `demo_reset {include:["agents"], dry_run:false, confirm:true}` (no `force`). Do a dry run first: it must list only those 8. Then rerun the lesson.
- **`chat-create-media`** is blocked, because it needs an image-generation key in the demo org (not approved). **`admin-plan-and-billing`** has no video by decision (cloud-only page).
- **Rebuilds:** `build-clip` can say "up to date" after a change in `src/core/tighten*` or in the storyboard. Use `--recut`.
- **Disk space:** every cut leaves a `.render-cache-*` folder of 1.5–3 GB in `out/cuts/<storyboard>/`. On 2026-10-03 these filled `/home` to 100% (48 GB of caches). `lesson-run` now drops a lesson's cache after a passing check. These caches are safe to delete; a rebuild renders them again:
  ```bash
  find /home/tom/Projects/Bee-Flow-AI-internal/clip-studio/out/cuts -mindepth 2 -maxdepth 2 -type d -name '.render-cache-*' -prune -exec rm -rf {} +
  ```
  Check `df -h /home` before large batches, and keep at least 15 GB free.

## Final round, after production

1. **Re-record old takes.** Lessons recorded before 2026-10-03 13:00 have a heavy navigation dim and a black focus ring; `status.mjs` marks them "re-record". Delete nothing. Instead run:
   ```bash
   node bin/clip.mjs lesson-run <id> --from record
   ```
   If that does not re-record a storyboard not made by lesson-run, use `node bin/clip.mjs retake <scene> --max 3` per scene (add `--allow-side-effects` where the scene sends something).
2. **Shorten videos over 180 s** (marked "shorten"). Drop or merge beats in the overrides or scene, then re-record those scenes.
3. **Rebuild everything with all fixes:**
   ```bash
   node bin/clip.mjs build-clip lesson-<id> --preset heart --subtitles --qa --recut
   ```
   Check 0 fails.
4. **Mapping:** add every `done` lesson to `clip-studio/learn-videos.json` (`"<lessonId>": "lesson-<lessonId>"`). Replace `using-memory` → `lesson-using-memory`; the pilot is the old style.
5. **Pack:** `node bin/clip.mjs learn-pack` → `out/learn-pack/`. It packs the burned-in subtitle variant and marks `burnedCaptions: true`.
6. **Install locally.** Remove files the old manifest listed and the new one doesn't, then:
   ```bash
   docker cp out/learn-pack/. beeflow-server:/app/data/learn-media/
   docker exec -u 0 beeflow-server chown -R node:node /app/data/learn-media
   ```
   Check:
   ```bash
   curl -s http://localhost:5176/learn-media/manifest.json | jq '.videos|keys'
   ```
7. **Wire the lessons.** In `.claude/handoff/curriculum/curriculum.json`, give each lesson with a video `"video": { "id": "<lessonId>", "titleFallback": "<short title>" }`. It goes after the opening slide by default. Then:
   ```bash
   node .claude/handoff/curriculum/generate.mjs
   npm run i18n:gen
   ```
   Tests:
   ```bash
   node --test .claude/handoff/curriculum/videoStep.test.mjs
   cd agent-hub && npx vitest related --run src/components/onboarding/generated/lessons.js src/i18n/en-defaults.js
   node --test server/learning/*.test.js
   npm run check:fast
   ```
8. **Local images** (the local stack runs from images, not from source). The old images are tagged `…:mapping-local-backup-20261003`.
   ```bash
   REGISTRY=ghcr.io/bee-flow TAG=mapping-local ./scripts/build-images.sh build dev server agent-hub
   cd /home/tom/Projects/Bee-Flow-AI && REGISTRY=ghcr.io/bee-flow TAG=mapping-local docker compose -p bee-flow-ai \
     -f docker-compose.from-registry.yml -f docker-compose.hub.local.yml -f docker-compose.berlin-demo.yml \
     up -d --no-deps --force-recreate server agent-hub
   ```
9. **Check in the app:** Settings › Learning Center › a course › a lesson › Replay/Play → the video step plays with subtitles and the transcript toggle.
10. **Report to the user.** Don't commit; the user decides.

## Not finished / open points

- Publishing the media pack (a GitHub Release asset or CDN) is **not** done. The user wanted it working locally first. The fetch script `scripts/learn-media-fetch.mjs` and `LEARN_MEDIA_BASE_URL` exist. A CDN needs an `EXTRA_MEDIA_SRC` / CSP `media-src` in nginx.
- Demo leftovers to tidy later, with the user's OK: see `data/seed-status.md` and the agents note above.
- Product bugs found along the way, not fixed:
  - same-tab "This agent changed elsewhere" right after publishing;
  - Studio Start "Needs attention" shows 9 rows;
  - DSR drawer still offers "Start working";
  - the `dlp.line_*` i18n keys are missing.
