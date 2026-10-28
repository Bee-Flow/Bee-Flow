---
title: "0003: One adapter per provider, one for all self-hosted runtimes"
description: Why every LLM provider is a file in server/core/providers, why Ollama, vLLM, llama.cpp and the others share one adapter, and why a model is priced by the stored provider type and never by a guessed URL.
---

# 0003: One adapter per provider, one for all self-hosted runtimes

**Status:** accepted, in effect. **Enforced by:** the adapter factory in
`server/core/providers/index.js`; `LOCAL_RUNTIMES` in `server/core/providers/localModels.js`.

## Context

Bee Flow talks to Anthropic, OpenAI, Google (API and Vertex), Azure, Mistral, Scaleway,
EU GPT and a growing list of self-hosted runtimes. Each differs in request shape, token
accounting and streaming. Early on, provider-specific code appeared wherever a model was
called, and a self-hosted endpoint was recognised by the look of its URL.

## Decision

Every provider is one file in `server/core/providers/`, created through the factory in
`index.js`; orchestration (`server/core/llm/`) never branches on a provider name. An
OpenAI-compatible provider holds only its differences (Scaleway: per-model reasoning
vocabulary, a `max_tokens` cap, usage in the stream). All self-hosted runtimes are one
adapter, `local.js`, with an instance per flavour; adding a runtime is one entry in
`LOCAL_RUNTIMES`, and the factory, presets, admin UI and autodetection follow from it.

Whether a model is local, and therefore priced at zero, is decided by the provider type
stored in the database, never by an adapter guessed from a URL. Open-weight models sold by
several hosts are priced through the exact `provider/vendor/id` key, never by a fuzzy name
match.

## Consequences

- A new provider or runtime is a bounded change in one directory.
- A paid endpoint can never be priced at zero by looking like a local one.
- Each adapter carries the provider's quirks in one place: Mistral's SDK silently drops
  unknown keys, so its adapter is tested against the SDK's real outbound schema; EU GPT
  returns no token usage and takes the history inside the user message.
