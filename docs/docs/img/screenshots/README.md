# Screenshots

This directory holds product screenshots referenced from the docs site.

## Convention — folder name matters, filename does not

Each topical screenshot lives in its own folder. **Drop a single PNG/JPG/WebP into the folder; the filename can be anything.** A MkDocs build hook (`hooks/screenshots.py`) picks up the first image alphabetically and rewires the docs page reference to it.

If a folder is empty, the page falls back to a broken-image placeholder so you can see at a glance what's still missing — the build never fails over a missing screenshot.

## Adding a screenshot

1. Take the screenshot (PNG, max 1600 px wide, no shadow/frame — the docs theme adds one).
2. Drop it into the right folder. Filename is up to you (`hero.png`, `2026-05-09.png`, anything).
3. Build / push — the docs site picks it up.

## Replacing a screenshot

Drop a new file in. If the folder ends up with two images, the alphabetically-first wins. Easiest pattern: delete the old file before adding the new one. Or include a date prefix: `2026-05-09-foo.png` sorts after `2026-04-12-foo.png`.

## Adding a NEW topic (a new screenshot location)

1. Pick a slug (e.g. `studio/agent-marketplace`).
2. `mkdir docs/img/screenshots/studio/agent-marketplace`.
3. Reference it from a `.md` page: `![alt text](../img/screenshots/studio/agent-marketplace/)` — note the trailing `/`.
4. Drop a screenshot in the folder when ready.

## Folder index

| Folder | Topic |
|--------|-------|
| `getting-started/nextcloud-app-store/` | Bee Flow App Store listing page in NC admin |
| `getting-started/nextcloud-topbar/` | Bee icon in NC top bar |
| `getting-started/wizard/step-1-user-sync/` | Onboarding wizard step 1 |
| `getting-started/wizard/step-2-integrations/` | Onboarding wizard step 2 |
| `getting-started/wizard/step-3-privacy/` | Onboarding wizard step 3 |
| `getting-started/wizard/step-4-license/` | Onboarding wizard step 4 |
| `connector/install-progress/` | AppAPI deploy progress UI in NC |
| `connector/heartbeat-ok/` | `occ app_api:app:heartbeat bee_flow` happy output |
| `features/chat-empty-state/` | Bee Flow chat first-load |
| `features/chat-tool-call/` | An inline tool-call row, expanded |
| `features/chat-shield-indicator/` | The redaction shield next to a message |
| `features/knowledge-citations/` | KB-cited reply with source cards |
| `features/knowledge-create/` | New KB modal |
| `features/automation-builder/` | Automation visual graph editor |
| `features/automation-run-history/` | Recent runs panel |
| `features/voice-call-active/` | Voice call SPEAKING state |
| `features/privacy-shield-settings/` | Settings → Org → Privacy panel |
| `studio/agent-designer/` | Advanced agent designer |
| `studio/agent-wizard/` | Guided agent creator |
| `studio/templates-marketplace/` | Template marketplace browse view |
| `studio/component-designer/` | Component designer working pane |
| `studio/knowledge-bases-list/` | KB library |
| `studio/skills-marketplace/` | Skills marketplace |
| `admin/users-and-groups/` | User management panel |
| `admin/nc-integrations-org/` | Org-level NC integration toggle grid |
| `admin/nc-integrations-per-group/` | Per-group disable list |
| `admin/organisation-settings/` | Org settings overview |
| `admin/beta-features/` | Beta-feature flag panel |
| `admin/audit-log/` | Guardrail event browser |
| `admin/license-apply/` | License & usage panel |
| `api/api-keys-panel/` | Settings → API keys (creation flow) |

## How the hook works

[`hooks/screenshots.py`](../../../hooks/screenshots.py) registers an `on_page_markdown` handler. It scans Markdown for image references whose path ends in `/`, looks inside the resolved folder, and rewrites the path to the first image found. The regex is conservative — explicit file references like `../img/foo.png` are untouched.

Hidden files and `README.md` files are ignored when picking images, so per-folder docs don't collide with the screenshot.
