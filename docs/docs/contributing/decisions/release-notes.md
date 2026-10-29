---
title: "0010: Release notes live on GitHub Releases"
description: Why the repository keeps no changelog file and lets CI draft the notes of every release in one place.
---

# 0010: Release notes live on GitHub Releases

**Status:** accepted, in effect. **See:** `CHANGELOG.md` (which says only this).

## Context

A changelog file and release notes drafted by CI are two lists of the same changes, and two
lists disagree the first time someone forgets one of them.

## Decision

GitHub Releases is the source of truth for what changed in each version. CI drafts the notes
for every release. The repository keeps `CHANGELOG.md` only as a pointer to that page.

## Consequences

- One list, written where the release is.
- A reader without network access to GitHub has the commit history, whose subjects are
  written as release notes.
