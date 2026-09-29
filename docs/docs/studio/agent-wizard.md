---
title: Agent wizard
---

# Agent wizard

A guided alternative to the [Agent Designer](agent-designer.md). The wizard asks 6 questions and produces a working agent without exposing the full surface area.

URL: `/app/agent-wizard`.

![Agent wizard](../img/screenshots/studio/agent-wizard/)

## Steps

### 1. What's this agent for?

Free-text. The wizard uses the **OrgIntel Scout** + **Prompt Designer** system agents to draft a starter system prompt, name and avatar from your description.

### 2. Who'll use it?

| Choice | Effect |
|--------|--------|
| Just me | Visibility: private. |
| My team | Visibility: specific groups (you pick). |
| Whole org | Visibility: org-wide. |
| Public | Submit to marketplace. |

### 3. What should it know?

| Choice | Effect |
|--------|--------|
| No special knowledge | No KB attached. |
| Pick existing KB | Multi-select from your KBs. |
| Upload a doc | Drop a PDF / Markdown / URL — wizard creates a new KB and attaches it. |

### 4. What should it be able to do?

A list of high-level capabilities — picking each toggles the relevant tool integrations:

| Capability | Tools enabled |
|-----------|----------------|
| Read my email | `gmail_*` or `outlook_*` |
| Manage my calendar | `*_calendar_*` |
| Search files | `nextcloud_files_*`, `gdrive_*`, `onedrive_*` |
| Track issues | `github_*`, `youtrack_*` |
| Talk to my team | `nextcloud_talk_*` |
| Create presentations | `gamma_*` |

The wizard maps these to the actual tool list — you don't need to know tool names.

### 5. How careful should it be?

| Choice | Effect |
|--------|--------|
| Standard | Privacy Shield: standard. |
| Strict (PII / addresses redacted) | Privacy Shield: strict. |
| Customer-facing | Strict (block mode) + Azure Content Safety moderation. |
| Internal-only | Standard. |

### 6. Review and publish

The wizard shows the generated agent — name, prompt, KBs, tools, privacy level — and lets you tweak before saving.

## Behind the scenes

Each step's output is saved to a `draftAgent` record. On confirm, that draft is materialised into a regular agent row, with the same shape as the [Agent Designer](agent-designer.md) produces. You can edit the result in the Designer afterwards if needed.

## When to use which

| Use the wizard | Use the designer |
|----------------|--------------------|
| First-time creator | Power user with specific needs |
| You want a "good enough" agent fast | You're tuning prompt + tool selection precisely |
| You don't know which tools to enable | You know exactly which tools to allow/deny |
| You want a low-friction template | You want to inspect / override every field |
