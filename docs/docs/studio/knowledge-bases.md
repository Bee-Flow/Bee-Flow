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

## The tabs

| Tab | What it is |
|---|---|
| **Sources** | Everything this base reads from, and how each one keeps itself current. |
| **Test question** | Ask the base something and see which source answered. |
| **Settings** | Name, purpose, where it may be used, who may see it, copy, delete. |
| **Used by** | The agents, chats and automations that use this base. |
| **Search log** | Enterprise, managers only, when the log is on: the questions asked, the passages found and the answers given, for review. |

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

## Search log (Enterprise)

A base can keep a log of the questions asked to it, so the people who manage it can check whether the AI answers correctly and see what is missing. It is **off by default**, per base, and needs the Enterprise licence.

**Turning it on.** On **Settings**, under **Log search queries and answers**. Only managers of the base see the card: its owner, or someone in the same organisation with the right to manage knowledge. Choose how long entries are kept (30, 90, 180 or 365 days); older entries are deleted automatically. A personal base cannot log. Switching on, switching off and changing the term are written to the organisation's access log.

**What an entry holds.** The time; the person asking; the channel (agent chat, direct chat, a notebook, a webpage, a project assistant, an automation's AI step, an App Studio step or chat, the support assistant, a skill, the **Test question** tab, the search API); the question as it went into the search; the passages found (document, source, title, score and the text as it was then); and, where the channel produces one, the answer, the model, the timings, the outcome (answered, no results, error) and the citations. A question the Privacy Shield had already masked is logged masked.

**Who sees it.** The managers of the base, on the **Search log** tab: filter by period, person, channel, outcome and review status, open an entry, set its status (**To review**, **Reviewed**, **Needs an addition**) with a note, and export to CSV. People who may only read the base never see the log. Compliance officers see which bases log and the counts, not the content; see the Compliance Center below.

**People are told.** While a base they ask logs, chat inputs show one line: *Questions to &lt;base&gt; are logged for quality control by the knowledge base's managers.*

**Encryption.** The content is encrypted with a key held by the organisation, so the base's managers can read it. On the zero-knowledge tier this means the log is **not** zero-knowledge: the card says so before you switch it on.

**Switching off.** Choose to keep the entries until their term ends, or delete them now. If the licence lapses, nothing new is logged, and the card offers **Turn off and delete the log**.

**For builders.** An App Studio action can read the log with `kb_log_query` and set a review with `kb_log_review`; an automation uses the `kb_query_log` step (`op: list` or `review`). Both require that the app's or automation's owner manages the base, and in an app the person using it too. They are refused on public apps and never write during a dry run. A list returns a summary unless the full detail is asked for, and an automation's run history never keeps the questions and answers.

**Compliance Center.** Under **Registers → Knowledge base search log**: every base with its setting, term, managers and counts; the entries as metadata only, with a CSV export; and data-subject requests. To see, export or erase one person's entries, the officer picks an open data-subject request about that person; that access is itself logged, and the request fails if the log entry cannot be written.

## A personal base

A base of your own shows **Move to my organisation** instead of an audience picker. It stays unshared until you pick an audience, but administrators will be able to see and manage it, and this cannot be undone.
