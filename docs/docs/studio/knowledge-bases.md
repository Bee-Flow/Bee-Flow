---
title: Knowledge bases (Studio)
---

# Knowledge bases (Studio)

This page is the UI walkthrough. For the technical underpinnings (embeddings, chunking, search), see [Features → Knowledge bases](../features/knowledge.md).

URL: `/app/studio/knowledge`. A knowledge base, its tab and an opened source all live in the path — `/app/studio/knowledge/<id>/<tab>/<sourceId>` — so every one of these screens is a link you can send someone.

![Knowledge bases list](../img/screenshots/studio/knowledge-bases-list/)

## The list

**Studio → Knowledge** shows every knowledge base you may see. Per row: its name, what is in it, who may see it, what uses it, and how current its content is — "updated 2 min ago", "weekly · Mon", or the warning "empty, but in use" when nothing has ever arrived in a base something already depends on.

Above the list: a search box (name and purpose) and one chip per category, plus **Uncategorised** when any base has none.

## Creating one

Click **New knowledge base**. There is no create form: the base is made immediately as "New knowledge base" and opens on its Sources tab. Give it its real name in the header, or on the **Settings** tab.

## The four tabs

| Tab | What it is |
|---|---|
| **Sources** | Everything this base reads from, and how each one keeps itself current. |
| **Test question** | Ask the base something and see which source answered. |
| **Settings** | Name, purpose, where it may be used, who may see it, copy, delete. |
| **Used by** | The agents, chats and automations that use this base. |

The header carries the name (click to rename), the visibility capsule, and a chip that reads **Updated &lt;when&gt;** — the moment content last arrived, not the last edit — or **Nothing in it yet**.

## Sources

A source is a *standing arrangement* to read something, not a one-off import: a folder, a page, a table, a meeting tag. Add it once and it keeps fetching.

**Add a source** offers seven kinds:

| Kind | What it adds |
|---|---|
| **Folder in Nextcloud** | *Coming soon.* The button is visible but disabled with that tooltip. |
| **Upload files** | Up to 20 files at a time, 20 MB each. Files over the limit are named and refused before they upload. |
| **Table** | A datatable; its columns become the row's description. |
| **Meeting notes** | Everything tagged with a chosen meeting tag. |
| **Web page / URL** | An address, optionally following links on the same site up to a page limit. |
| **Paste text** | One pasted snippet. |
| **Let an automation fill it** | Not a form. It explains that a source of this kind appears when an automation writes to this base — which you set up in the automation, and the panel links you there. |

Sources created before the source model exist as **Imported** rows. They cannot be created and have no button.

Each row shows the kind's icon, the source's name, and a second line in the source's own terms ("38 files", "columns Article, Description, Price", "pasted text · by Tessa") — rather than the same document count five times over. Above the table: `N sources · N documents · N refresh automatically`.

### Keeping a source current

The refresh cell says the rule; the column beside it says when it last ran, or **never**. The row's ⋯ menu has **Refresh now**, **Rename**, **Refresh schedule…**, **Open** and **Delete**.

The schedule menu offers only what the kind supports, because the server refuses the rest:

| Kind | Modes |
|---|---|
| Upload, Paste text, Imported, automation | manual |
| Web page / URL | manual, on a schedule |
| Folder in Nextcloud | manual, on a schedule, on change |
| Table | manual, on a schedule, live |
| Meeting notes | manual, after every meeting |

Schedules come from three presets — every day at 06:00, every Monday at 06:00, the 1st of each month at 06:00 — and the menu names the timezone they are written in. A stranger cadence is an operator PATCH, and shows as a custom schedule rather than being mislabelled as a preset.

### Inside a source

Open a source to see every document in it. Filter chips: **All**, **Processed**, **Skipped**, **With personal data**.

| Status | Meaning |
|---|---|
| processed | Read and usable. |
| shielded | Privacy Shield replaced personal data *before* the text entered the base. Also a success — the AI knows the terms, not the customer. |
| skipped | Not taken in; the row says why. |
| failed | Extraction went wrong; the row says why. |
| duplicate | The same content is already in this base. |
| processing | Queued or still being read. |

A file that could not be read gets a row with a reason. It used to get no row at all, which is how a folder of 38 files quietly became a base of 36.

Studio deliberately shows no chunk counts and no re-index button: those are facts about the retrieval implementation, not about your material.

Under the table: *whoever may see this knowledge base also sees what the AI quotes from it. Sources containing personal data are marked by Privacy Shield automatically.*

## Test question

Ask this base a question. The sources it found render first, before the answer streams in — the question being tested is "did it find the right passage?", and an answer shown first invites believing it. Passages get a bar relative to the best hit in the same answer, never a percentage. "The sources do not cover this" is a result, not an error.

## Settings

| Setting | Notes |
|---|---|
| **Name** | Commits on blur. |
| **What is in it** | One sentence an agent can read to decide whether to look here. |
| **Where it can be used** | Agents / Chat / Automations — which pickers offer this base. |
| **Who may see and use it** | Personal, entire organisation, or specific groups. |
| **Category** | Groups it in the list's chips. |
| **Make a copy** | **Empty copy** or **Copy with its sources**. |
| **Delete this knowledge base** | Under a confirmation, with what still uses it. |

Two distinctions the screen makes and that are easy to get wrong:

- **Where it can be used** does not change who may read what is in it. It decides which pickers offer the base; the audience is set separately, below it.
- An agent can only answer from this base for someone who may see it. **Everyone else gets the same answer with this base left out — never an error.**

**Make a copy** never copies documents. A copied source reads its own files and pages again on its first refresh, so the copy gets what is there now.

Deleting takes the base's documents with it. The original files, pages and folders they were read from stay where they are. When something that uses the base could not be checked, the confirmation says so rather than presenting a partial list as a complete one.

## A personal base

A base of your own shows **Move to my organisation** instead of an audience picker. It stays unshared until you pick an audience, but administrators will be able to see and manage it, and this cannot be undone.
