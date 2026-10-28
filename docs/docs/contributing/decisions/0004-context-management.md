---
title: "0004: Two context-management mechanisms, lossless by default"
description: Why long chats are kept within a model's context window by the provider's lossless context management by default, with a lossy local compaction that an organisation turns on itself.
---

# 0004: Two context-management mechanisms, lossless by default

**Status:** accepted, in effect. **Code:** `server/core/providers/claude.js`
(`context_management`), `server/core/llm/compaction.js`, `server/core/llm/contextPolicy.js`.

## Context

A chat that runs for days outgrows any context window. Two ways exist to keep it going: ask
the provider to manage the context (Anthropic's `context_management`, which loses nothing
the model needs) or summarise locally with a fast model and truncate old tool results,
which is cheaper and works with every provider but loses detail.

## Decision

Anthropic's context management is on by default. Local compaction exists, is off by default,
and is enabled per organisation. With compaction off, one emergency brake remains: a fold when
the conversation nears the model's context window. Thinking blocks are replayed, so message
sanitising must keep `thinking`; an adapter that passes messages straight through strips
internal fields itself.

## Consequences

- The default never discards content the model may need; the price is paid in tokens.
- An organisation on a provider without context management, or one that prefers cost, opts
  into compaction knowingly.
- Two mechanisms must not be mixed up in code or in a bug report: the lossy one is
  `compaction.js`, the lossless one lives in the Claude adapter.
