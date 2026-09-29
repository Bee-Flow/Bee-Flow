---
title: Webpages
---

# Webpages

A webpage in Bee Flow is a small page you **describe in chat** and the AI builds — a
status page on top of one of your tables, an intake form that starts an automation, a
dashboard on a run's result. You then refine it, decide who may see it, and publish.

URL: `/app/studio/webpages` · one page opens at `/app/studio/webpages/:id`.
The legacy `/app/webpages[/<id>]` paths resolve into the same Studio section.

**Tier:** Community for building and keeping your own pages; sharing a page beyond
its author (publishing it to the organisation or to groups, per-person grants, public
share links) is Enterprise (`webpage_sharing`). The section is gated on `webpages`, the
same entitlement the server puts in front of `/api/webpages`. An organisation whose plan
leaves Webpages out sees the row in the Studio rail **disabled with an upgrade hint**
rather than not at all; opening it anyway lands on a panel that says Webpages is not
enabled for this account and to ask an admin, rather than a screen that 403s on every
request.

## The list

- **New webpage** takes a name and creates an empty page you describe later in its
  chat. (Studio's global **New → Webpage** navigates to `/app/studio/webpages/new`,
  which is the list opened ready to create — `new` is a reserved id, never a page.)
- **Search** filters the list.
- **Start from an example** offers four briefs — *Status page on a table*, *Intake form
  → automation*, *Dashboard on an automation run*, *Chat with an agent*. These are
  **prompt presets, not templates**: clicking one fills the build bar with a brief you
  can still edit. There is no template entity behind them.
- Each card can be opened, edited, renamed, cloned or deleted.

## One page

The editor header carries the tabs:

| Tab | What it holds |
|---|---|
| **Preview** | The page as it renders |
| **Data & links** | Five panes — *Overview*, *Actions*, *Who can see it*, *Sources*, *Database* |
| **Code** | The file slots, owner only |
| **History** | Every saved version, owner only |
| **Used by** | Where this page is referenced |

Code and History are owner-only on purpose: a viewer's every keystroke would fail to
save, so the editor is not offered rather than offered and refused.

The primary action is **Publish** (**Republish** once the page has been published —
"freeze the current version for the people who can already see this page"). Beside it,
**Add image** and **Download ZIP**.

### Data & links

- **Overview** — which datatables this page is bound to, which routines feed those
  tables, the page's own knowledge sources, and a warning per routine that writes
  straight into a bound table.
- **Actions** — what the page sets off: a static scan of its own code for calls that go
  around Studio, the forms and agent blocks that arrive with `bf-*`, and the bridge
  grants (which routines and integrations the page's script may call).
- **Who can see it** — the three shared audience rows (personal / organisation /
  groups) plus a fourth, **Public**. The address card underneath holds `/w/<slug>`, with
  *All options* (password, e-mail addresses, expiry) collapsed below it.
- **Sources** — the documents and URLs the AI reads while building the page.
- **Database** — the page's own table viewer.

### What "Public" actually means

A public webpage is a **snapshot**, not a live page, and three things follow from that:

1. Table blocks on a public page are **read-only** — read/write exists only for
   Personal, Organisation and Groups audiences.
2. The **agent block does not run** there.
3. The **plain AI chat does** run there when it is switched on, grounded on the page's
   own knowledge and charged to the author's budget.

Which columns of a bound table may appear on the public page is an explicit **column
gate**: nothing is pre-ticked when a page is not yet public, because pre-ticking turns
"which columns may go out" into an agreement nobody read.

Turning Public **off** revokes the canonical share and leaves the address in place — and
any separate `/share/<token>` link of the same page keeps serving its frozen snapshot.
The screen says so out loud, because "Off" over a page that is still reachable
anonymously is the dangerous direction.

A page whose audience is *Personal* but which has a live public share reads as
**Public** in the visibility capsule. Public is checked first because it is the widest.

### History

Unknown is not zero and not you: a version whose author the server does not know is
labelled **Unknown**, never "You" and never a blank.

## Where to next

- [Studio → Datatables](datatables.md) — the rows a page reads.
- [Studio → Forms](forms.md) — when the page you want is really a form on a routine.
