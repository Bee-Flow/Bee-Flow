---
title: Skills
---

# Skills

A **skill** is a reusable method: what it does, when to use it, the ordered steps to follow, the rules that always hold, the fields it hands back, and what it is allowed to reach while it runs. Attach it to an agent and the agent works that way — without you rewriting the agent's own instructions.

URL: `/app/studio/skills` (the Studio rail, under **AI**). There is no `/app/skills`.

![Skills section](../img/screenshots/studio/skills-marketplace/)

## Availability

`skills` is a **Community** feature — it is in the free core, not behind a paid tier. It is also a **beta**, so the licence alone is not enough: the section stays visible but disabled until an admin switches the Skills beta on under **Admin → Beta features**.

That combination is deliberate. `/api/skills` sits behind a compound capability — licence **and** beta opt-in — so an org that never enabled the beta sees a locked row with a hint, instead of an open section whose list quietly returns nothing.

## The landing is a table

Opening the section with no skill selected shows **All skills**, four columns wide:

| Column | What it says |
|--------|--------------|
| Skill | Name, plus what it is made of — "4 steps · 3 rules · 2 examples" |
| Used by | "3 agents · 1 automation" |
| Last time | When the skill last actually fired |
| Test | The verdict of the last test run |

Two of those columns can be blank, and blank does not mean zero. The usage figure comes from a separate read that skips a skill it could not count, and "last time" is empty until an activation has actually been recorded. Both render as an em dash rather than "nobody" / "never" — the difference between *nothing uses this* and *we have not looked* is usually the reason someone opened the table.

A skill with no steps and no description gets an offer instead of a verdict: **Let AI fill it in** drafts the method for you.

## What a skill is made of

A skill opens on four tabs: **Method**, **Examples**, **Test**, **Used by**.

### Method

| Block | What it holds |
|-------|---------------|
| What this skill does | A short summary |
| When to use it | When and how the agent should reach for it (max 4000 characters) |
| Steps | Ordered cards you can drag. Each step is a sentence plus optional **reference pills** — a routine, a knowledge base or a table it points at |
| Rules | Statements that hold regardless of the question. Each rule is **must** or **never**; the mark is a button that flips it |
| Delivers | The fields the skill hands back, in the product's own field vocabulary (text, number, yes-no, date, one of a list, table). A routine's AI step takes its outgoing fields from here |
| May use | The three grants below |

**May use** is three lists, and each is a request rather than an authorisation — ownership and activity are re-checked when a tool is actually dispatched:

- **Apps** — tools of these apps become available while the skill is active. An app your org has not connected is not offered.
- **Routines** — offered to the agent as callable tools, which is why only a routine with an **agent-call** trigger can be picked. The runtime dispatches nothing else, so listing a scheduled routine here would be a promise nothing keeps.
- **Knowledge** — joined into the agent's search allowlist while the skill is active.

Under **All options** in the same block sits **dynamic activation** — see [How a skill reaches a turn](#how-a-skill-reaches-a-turn).

### Examples

Each card is *question → good answer*, plus why it is good. A **"Not like this"** half, tied to the rule it breaks, is opt-in: a wrong answer in the prompt is a thing the model has now read, so it earns its place only once the good half exists and the agent keeps getting one specific thing wrong.

**Pick from a conversation** takes an answer that already happened. Two rules make that safe, and both are enforced on the server: the conversation must be your own, and the text is read with Privacy Shield tokens left as tokens and re-scanned before it is stored.

### Test

**Test** runs one agent turn with this skill in the system prompt and a closed, read-only tool list, then grades the answer step by step. The answer streams first and the verdict second, so you read what the agent actually said before being told what a grader thought of it.

You can run it against just the skill, or through one of your agents. A run only searches the knowledge bases your own account may read.

The tab refuses to smooth over failure: a run that could not be graded shows the failure rather than an empty result list, a step the grader stayed silent about arrives as a warning with its own sentence, and a stream that ended without a verdict says so instead of leaving a half-finished answer looking like a success.

### Used by

Which agents and which routine AI steps name this skill. A read that failed is named as such rather than shown as an empty list.

Deleting lives at the bottom of this tab in the shared **danger zone** — not in the list and not in a menu — and it confirms against the same list the tab renders, including the kinds that could not be checked. The server refuses a delete for a skill still in use.

## How a skill reaches a turn

An agent carries its skills on its own configuration (`config.attachedSkillIds`), picked from the **Skills** button in the agent builder. A routine's AI step can apply a skill too (`ai_step.skillIds`).

From there, two behaviours:

- **Static** (the default) — the skill's full body goes into the system prompt on every turn.
- **Dynamic** — only a one-line manifest entry goes in, and the agent calls `activate_skill` to pull the full body in when it is actually relevant. This saves tokens when an agent has many skills attached but only a few apply per message.

The same split governs the grants: a dynamic skill contributes no apps, routines, tables or knowledge bases until it has been activated in that conversation.

A legacy per-skill `automationId` still exists and behaves completely differently — the routine **replaces** the skill body. It is explained in place rather than hidden, because a field with that much power should not be invisible just for being old.

## Permissions

Writes are gated by `manage_skills`, which ships with the **org admin**, **agent admin** and **agent editor** roles. The server re-checks it on every write; the interface only decides which controls are worth drawing.

Reading the list is not gated by `manage_skills` — anyone who can reach the section can see what exists.

## There is no skills marketplace

Skills are not browsed, installed, published publicly, forked or versioned. Nothing in the product ships a curated skill catalogue, and there is no public submission flow. You write a skill, or you let the AI draft one and edit it.

The only marketplaces in the product today are **Modules → Marketplace** (super-admin) and the **Catalogue** tab in [Solutions](solutions.md). To move a skill between installs, package it in a Solution.

## Skills vs agents

| | Skill | Agent |
|---|-------|-------|
| Standalone? | No — attached to an agent or applied by a routine step | Yes |
| Reusable across agents? | Yes, one definition attached in many places | No |
| Changing it | Applies everywhere it is attached, at once | Affects that agent only |
| Use case | "Give this agent this method" | "Talk to this agent" |
