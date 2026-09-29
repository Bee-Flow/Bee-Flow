---
title: Fireflies
---

# Fireflies

[Fireflies.ai](https://fireflies.ai) joins meetings as a bot and produces transcripts. Bee Flow reads them so the assistant can answer "what did we agree on Tuesday's call?"-style questions.

## Setup

1. Get an API key from your Fireflies workspace settings.
2. Set environment:
   ```bash
   FIREFLIES_API_KEY=<key>
   ```

## Tools

| Tool | Purpose |
|------|---------|
| `fireflies_list_transcripts` | Recent transcripts. |
| `fireflies_search_transcripts` | Search across transcripts. |
| `fireflies_get_transcript` | Read one transcript with speaker labels. |
| `fireflies_get_summary` | Read AI summary + action items. |

## Use cases

- "Find action items assigned to me in last week's calls."
- "Summarise yesterday's design review."
- (Automation) On a new transcript, post the summary to a Talk channel.

## Privacy

Transcripts contain people's names and verbatim utterances. The Privacy Shield runs over them before reaching the model — Strict mode is recommended for transcripts.

## Bee Flow's own meeting bot

Bee Flow also has a built-in meeting bot ([`/api/meet-bot`](../api/rest.md#meeting-notes-and-transcriptions-enterprise), Enterprise). The Fireflies integration complements rather than replaces it — use whichever matches your existing workflow.
