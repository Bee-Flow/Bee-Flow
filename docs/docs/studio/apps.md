---
title: App Studio
---

# App Studio

App Studio lets you build internal apps — trackers, dashboards, intake forms, small
tools — inside Bee Flow, without writing code. Describe what you need and the AI
builds the whole thing: a data model, sample data, the screens, and the logic that
ties them together. Then you refine it visually.

URL: `/app/studio/apps` · end-users open a published app at `/app/apps/:id`.

**Tier:** Enterprise (GA). App Studio is on by default for Enterprise organisations;
an org admin can disable it under beta/feature settings. Everyone who opens a
published app needs the same Enterprise `app_studio` entitlement (apps are only
shareable inside your organisation).

## Build with AI

Open **Studio → Apps → New**, then describe the app in the builder chat:

> "Build a ticket tracker. Tickets have a title, status (open/in-progress/done),
> priority, and an assignee. A kanban board grouped by status, a form to file a new
> ticket, and a 'My tickets' screen that only shows the current user's tickets."

The AI builds it end to end:

- **Data model** — it designs tables with typed fields (text, number, date, select,
  relation, file, …), relations between tables, and per-role access rules.
- **Sample data** — it seeds realistic demo rows so the app isn't empty.
- **Screens & components** — forms, tables, data grids, charts, kanban boards,
  calendars, record-detail views, stats, and more, wired to your data.
- **Actions** — buttons and forms that create/update records, run one of your
  [Routines](../features/automations.md), navigate, or call an external connector.
- **Roles & access** — it can set up roles (e.g. *admin*, *member*) and row-level
  rules (e.g. members see only rows they created).

**Plan first.** For a larger app the AI proposes an editable **plan** — the screens,
tables, roles and datasets it intends to build — as a card in the chat. Review it,
tweak any part, then hit **Build it**. Small changes ("make the header blue", "add a
notes field") skip the plan and apply directly. Before finishing, the AI **dry-runs**
the app — it actually reads the data through each binding, as the owner and as each
role, and fixes anything that comes back empty or broken.

Every AI turn is one undo step, and the builder writes **checkpoints** you can revert
to from version history.

## The visual editor

Anything the AI builds, you can refine by hand:

- **Component ribbon** — the strip at the top of the canvas groups every component
  by category (Basics, Content, Layout, Data, Input). Click to add, or drag onto the
  canvas; hover any card for a short description of what it does. The strip stays one
  row tall — long categories scroll sideways — and can be collapsed to just its tabs
  when you want the canvas. Both side panels (the AI builder chat and the inspector)
  collapse and resize the same way, so the editor fits comfortably on a laptop screen.
- **Inspector** (right panel) — **Content**, **Style**, **Logic** and **Actions** for
  the selected component. Logic covers visibility (`Only show when …`), enablement,
  field validation rules, and computed values — all written as safe formulas with a
  live preview and a variable picker (`currentUser`, form fields, `screen.params`,
  datasets, …).
- **Data bindings** — point a component at a table (with filters + sort), a saved
  dataset/query, a formula, a routine result, or an external connector. Filters can
  use formulas (e.g. show rows where `assignee == currentUser.id`).
- **Preview / view-as-role** — switch to Preview to use the app live, and view it as
  any role to check what that role sees. (Row security is always enforced by the
  server, not just the preview.)

## Data tables, roles & access

Open **Data** to design the data model directly: add tables and fields, define
relations, and set **access**:

- **Access mode** per table — `app` (everyone who can open the app), `owner`, `role`,
  or `none`.
- **Row-level rules** per role — a bounded expression over `record.*` and `viewer.*`
  (e.g. `record.created_by == viewer.id`). These compile to parameterised SQL on the
  server; there is no way for an app to run raw SQL.

Every app gets its own private database. Records are created with the acting user
stamped in `created_by`, and all reads/writes are filtered by the role rules — so a
member can never see or change rows a rule hides, regardless of what the screen shows.

## External connectors

An app can read from external sources through **connectors** (Data → Connectors):

- **Integration tool** — call one of your connected integrations.
- **Routine** — run one of your Routines and use its output.
- **REST** — an HTTPS endpoint with a declared parameter list.

Connectors run **as the app owner** on the server (never with viewer-supplied
credentials), behind an SSRF guard that blocks private/internal addresses. The AI can
*wire* an existing connector into the app, but it never authors credentials — you set
those up yourself.

## Publishing & consuming

Publish from the editor's **Publish** button. Three audiences:

- **Private** — only you (unpublish).
- **Entire organisation** — everyone in your org.
- **Specific groups** — pick one or more groups.

Published apps appear for your audience at **`/app/apps`** (the Apps directory) and
open at `/app/apps/:id`. Apps are responsive — the layout stacks on mobile.

### Publish to the Nextcloud app menu

If your organisation's Nextcloud is connected to Bee Flow (the [Nextcloud
connector](../getting-started/nextcloud.md)), a published app can also get **its own
icon in Nextcloud's top bar**. Tick **"Show in the Nextcloud app menu"** in the
Publish dialog and apply; Bee Flow tells the connector right away, the connector
adds the menu entry, and the dialog confirms it — **reload Nextcloud to see the
icon**. It opens the app on its own page inside Nextcloud — buttons, forms, data
grids and automations all work through the user's Nextcloud sign-in.

Things to know:

- **Everyone on the Nextcloud sees the icon.** Nextcloud's menu entries for
  connected apps are instance-wide — there is no per-group entry — so the icon
  cannot follow a "Specific groups" audience. Only the audience you chose can
  use the app: a colleague outside it who opens the icon sees a notice that the
  app is shared with specific groups and whom to ask. Access, roles and
  row-level rules are enforced by the Bee Flow server exactly as inside Bee Flow.
- **Renames, unpublishes and deletes propagate right away** too. If the
  connector cannot be reached at that moment (the dialog then says "within a
  few minutes"), its own periodic check picks the change up — every 5 minutes
  by default, `BEEFLOW_STUDIO_MENU_SYNC_SECONDS` on the connector. Unpublishing
  removes the entry; republishing restores it without re-opting-in.
- Nextcloud users must be synced Bee Flow users in the app's organisation
  (that's the connector's normal user-sync) and the org needs the
  `app_studio` entitlement.

## Limits & quotas

App Studio enforces generous per-app limits. Writes are blocked with a clear message
(HTTP 409, `code: quota_exceeded`) once a cap is reached; **deleting rows always works**
so you can recover. An amber "Storage NN%" pill appears on an app's card once its
database passes 80% of the size cap.

| Limit | Value |
|-------|-------|
| Tables per app | 50 |
| Fields per table | 100 |
| Rows per table | 100,000 |
| Rows per app | 500,000 |
| Database size per app | 256 MB |
| Attachment size | 25 MB |
| Attachments per app | 5,000 |
| External connectors per app | 20 |
| Screens · components · actions | 20 · 500 · 60 |
| App definition size | 512 KB |

**Rate limits** (per user, per app; env-tunable on self-hosted): AI builder 12/min,
data reads 60/min, data writes 20/min, action runs 10/min, sequence steps 60/min,
connector runs 20/min.

Org admins can see per-app and total storage under **App Studio usage**
(`GET /api/studio-apps/usage`).

## Templates & remix

**New → From a template** ships ready-made, data-backed starting points (CRM pipeline,
ticket tracker, asset inventory, event planner, team directory) — each with a data
model and sample data. Choose **Remix with AI** to instantiate a template and open the
builder with a prompt prefilled, so you can adapt it by describing the changes.

## Where to next

- [Automations](../features/automations.md) — the Routines your app's actions can run.
- [Licensing → Tiers](../licensing/tiers.md) — where App Studio sits in the tier matrix.
