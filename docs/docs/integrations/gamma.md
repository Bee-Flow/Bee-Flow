---
title: Gamma
---

# Gamma

[Gamma](https://gamma.app) generates beautiful presentations from a prompt. Bee Flow's Gamma integration lets the assistant create / edit decks on the fly.

## Setup

1. Get an API key from your Gamma workspace.
2. Set environment:
   ```bash
   GAMMA_API_KEY=<key>
   ```

## Tools

| Tool | Purpose |
|------|---------|
| `gamma_create_presentation` | Start creating a new Gamma presentation, document, webpage, or social post from text. |
| `gamma_create_from_template` | Start creating a new Gamma from an existing Gamma item used as a template. |
| `gamma_revise_as_new` | Workaround for editing: create a new revised Gamma from supplied existing content plus edit instructions. |
| `gamma_get_generation_status` | Check the status of an existing Gamma generation ID. |
| `gamma_list_themes` | List available Gamma themes in the authenticated workspace. |
| `gamma_list_folders` | List Gamma folders the authenticated user can access. |

## Use cases

- "Build a 10-slide pitch from this product brief."
- "Add a closing slide with our contact info."
- "Export the Q3 review deck as PDF and upload to `/Decks/Q3-review.pdf`."

## Preview pane

When `gamma_create_presentation` runs, the SPA opens the [Gamma Preview Panel](../studio/index.md) on the right side of the chat — you see the deck rendering in real time.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Unauthorized` | API key invalid | Re-issue. |
| `Rate limit` | Gamma's per-account cap | Throttle calls; raise plan. |
| `Slide too large` | Asset > 5 MB | Compress or link externally. |
