---
title: "0027: One adapter per provider; the stored provider type is read outside the adapters"
description: Why every LLM provider stays one adapter file, where code outside the adapters compares the stored provider type today (model registration, price keys, the path a call takes, configuration), and why a price never follows a guessed adapter.
---

# 0027: One adapter per provider; the stored provider type is read outside the adapters

**Status:** accepted, in effect. **Supersedes:** [0003](./provider-adapters.md). **Code:** the
adapter factory `getAdapter` in `server/core/providers/index.js`; `LOCAL_RUNTIMES` in
`server/core/providers/localModels.js`; the files listed under Decision. **Enforced by:**
`server/core/llm/modelCache.test.js` (a Scaleway-typed and an IONOS-typed provider pin their models
to their own tariff, an OpenAI provider on the EU endpoint marks and unmarks its models),
`server/core/llm/modelCosts.local.test.js`, `modelCosts.scaleway.test.js` and
`modelCosts.ionos.test.js`. **Not enforced:** no check limits where a provider type may be
compared; the list below is what the code does today.

## Context

Record 0003 said that orchestration (`server/core/llm/`) never branches on a provider name. The
code does. A price is computed far from the provider record, so the module that resolves a
provider's models tells the pricing code which host serves them. Embeddings do not go through an
adapter method and build their own request by provider type. And a few provider behaviours
(regional processing, chaining a response to the previous one) are decided where the route or the
turn is. The rest of record 0003 describes the code correctly and is kept here.

## Decision

- **Every provider is one adapter file, made by the factory.** The files in
  `server/core/providers/` are `claude.js`, `openai.js`, `google.js`, `googleVertex.js`,
  `azure.js`, `mistral.js`, `scaleway.js`, `ionos.js`, `eugpt.js` and `local.js`. `getAdapter`
  returns the adapter of the stored provider type; only for a provider without a known type does
  it look at the URL, and it falls back to the generic OpenAI-compatible adapter. An
  OpenAI-compatible provider holds only its differences.
- **All self-hosted runtimes are one adapter**, `local.js`, with an instance per flavour. Adding a
  runtime is one entry in `LOCAL_RUNTIMES`; the factory, presets, admin UI and autodetection follow
  from it.
- **How a provider's chat API is called belongs in its adapter**: the request shape, streaming,
  token accounting and the provider's quirks.
- **Code outside the adapters compares the stored provider type**, in these places:
  - *Registering models for pricing.* `server/core/llm/modelCache.js`, when it resolves a
    provider's models: self-hosted models are registered as free, Scaleway and IONOS models are
    pinned to their own tariff, Mistral models get Mistral's price, Azure deployments are
    refreshed, and for Mistral, OpenAI and Azure the regional uplift is read from the stored URL
    of that provider. `server/core/kb/embeddingCost.js` pins Scaleway and IONOS embedding models
    the same way.
  - *Price keys.* `server/core/llm/pricingService.js`: Scaleway and IONOS (`STRICT_PROVIDERS`)
    take an exact key or no price, and an OpenAI model takes no reseller's key.
    `server/core/llm/modelCosts.js` (`inferProviderType`): for a bare model id, the registries
    above come first and the prefix of the id second.
  - *The path a call takes.* `server/core/agentRuntime/chatStream/roundRequest.js`
    (`NATIVE_TYPES`: the types that stream through their adapter), `server/core/embed/dispatch.js`
    and `server/stores/memoryEmbedding.js` (the Azure form of the embeddings request),
    `server/core/embed/outputDimensions.mts` (the embedding sizes of Scaleway and IONOS models),
    `server/routes/ai/directChat/sessionSkillSetup.js` (an OpenAI turn continues from the previous
    response) and `server/usecases/ai/directChat/finalizeContent.js` (an empty Claude answer that
    has thinking). `server/core/llm/llmClient.js` compares no type, but asks which adapter class
    it was given (Google, self-hosted) to force a tool call.
  - *Configuration.* `server/core/llm/providerConfig.js` (the default providers it creates carry
    a type; the saved Mistral key goes to a provider typed Mistral),
    `server/core/documents/ocr.js` (whether the default provider's key is a Mistral key),
    `server/routes/ai/providers.js` (regional processing is an OpenAI setting) and
    `server/routes/ai/config/modelTiers.js` (a tier for EU-only use refuses an OpenAI provider
    that is not on the EU endpoint).
- **A price follows the stored provider type, never a guessed adapter.** Whether a model is
  self-hosted, and therefore free, is decided by the type stored with the provider
  (`isLocalProviderType(provider.type)` in `modelCache.js`). Open-weight models that several hosts
  sell are priced through the exact `provider/vendor/id` key, never by a fuzzy name match.
- **Where no type is stored, a URL stands in for it, and sets no price.** A legacy
  single-provider configuration has no stored type; `providerConfig.js` and
  `core/documents/ocr.js` then read the host to decide whether the Mistral key applies, and
  `getAdapter` detects an adapter from the URL. `roundRequest.js` lets an adapter detected that way
  choose the streaming path. The price registries in `modelCache.js` read the stored type only.

## Consequences

- A new provider or runtime is still a bounded change in `server/core/providers/`, but not the
  whole change: a provider with its own tariff, region or non-chat endpoints also touches the
  files listed above. That list is the checklist.
- A paid endpoint cannot be priced at zero by looking like a local one.
- The comparisons are spread over more than ten files and nothing counts them. A new provider
  type that needs one of these branches, and does not get it, raises no error: no test or gate
  names the missing branch.
- Each adapter carries its provider's quirks in one place: Mistral's SDK silently drops unknown
  keys, so its adapter is tested against the SDK's real outbound schema; EU GPT returns no token
  usage and takes the history inside the user message.
