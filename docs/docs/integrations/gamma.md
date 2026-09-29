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
| `gamma_create` | Create a new presentation from a brief. |
| `gamma_list` | List your decks. |
| `gamma_get` | Read a deck (slides + speaker notes). |
| `gamma_update` | Edit a slide or add new ones. |
| `gamma_export` | Export to PDF / PPTX. |

## Use cases

- "Build a 10-slide pitch from this product brief."
- "Add a closing slide with our contact info."
- "Export the Q3 review deck as PDF and upload to `/Decks/Q3-review.pdf`."

## Preview pane

When `gamma_create` runs, the SPA opens the [Gamma Preview Panel](../studio/index.md) on the right side of the chat — you see the deck rendering in real time.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Unauthorized` | API key invalid | Re-issue. |
| `Rate limit` | Gamma's per-account cap | Throttle calls; raise plan. |
| `Slide too large` | Asset > 5 MB | Compress or link externally. |
