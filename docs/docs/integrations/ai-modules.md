---
title: AI modules
---

# AI modules

Built-in AI capabilities exposed as tools — image generation, video generation, music, TTS, transcription, and the local agent-search engine. No external OAuth required; gated only by the corresponding API keys (and, for images, the Azure image deployments) an admin sets.

## Image generation

| Tool | Backend | Notes |
|------|---------|-------|
| `generate_image` | Google (Gemini image models) or Azure (image deployments in Microsoft Foundry) | One image per call. The person picks the model in the chat's media panel. |

Image generation is available as soon as one image model is configured: the Google API key, an Azure image deployment, or both. The chat, agents and automations offer the same models. The icon generator takes a Google model, or the first Azure deployment when there is no Google key. Generated images are stored short-term in Bee Flow's blob store and served via signed URLs that expire in 24h. Add to a Knowledge Base or upload to Files for permanent storage.

**Google.** Set the Google API key under **Admin → AI Config → API Keys**. It gives two models: Flash Image (fast) and Pro Image (quality).

**Which model is used.** The model the person picked, when it is still configured. Otherwise Google's Flash Image when there is a Google key, and otherwise the first Azure deployment. Through the API, an Azure model is named `azure/<deployment>`.

An admin can limit how many images each person generates per hour, 24 hours, 7 days or 30 days: see [Image limits](../admin/users-and-groups.md#image-limits).

### Azure image deployments (Microsoft Foundry)

Images can also be made by image models you deploy in your own Microsoft Foundry resource. They use the endpoint and key of the Azure provider, so set those first under **Admin → AI Config → API Keys → Azure**.

1. In Microsoft Foundry, deploy a supported image model (see the table below) in the resource whose endpoint and key Bee Flow uses. Note the deployment name.
2. In **Admin → AI Config → API Keys → Azure**, add the deployment to the list of image deployments:

   | Field | What to enter |
   |-------|---------------|
   | Deployment | The deployment name, exactly as in Foundry. |
   | Model | The model behind the deployment, such as `gpt-image-1.5` or `MAI-Image-2.6`. It decides which API Bee Flow calls. Empty: the deployment name is taken as the model. |
   | Price per image (EUR) | Optional. What one image costs you: the price from your Azure price sheet. See [Cost](#cost). |

3. Save. The deployment appears in the media panel as `<model> (<deployment>)`, or as the deployment name when the two are the same.

You can list up to 20 image deployments.

| Model family | Models | What Bee Flow calls |
|--------------|--------|---------------------|
| OpenAI image models | `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2.5-*` | `POST <endpoint>/openai/v1/images/generations?api-version=preview` |
| MAI image models | `MAI-Image-2.5`, `MAI-Image-2.6` | `POST <endpoint>/mai/v1/images/generations` |

Not available on Azure:

- **FLUX** models. Foundry serves them on a separate provider route that Microsoft does not document, so Bee Flow does not call them. Do not add a FLUX deployment.
- **Music and video.** Foundry has no music model. Music and video generation stay on Google (and ElevenLabs for music and speech).

The aspect ratio the person picks is mapped to a size the model accepts. The OpenAI image models know three sizes: square, landscape (1536×1024) and portrait (1024×1536), so 16:9 and 4:3 both come out landscape.

## Video generation

| Tool | Backend | Notes |
|------|---------|-------|
| `video_gen` | Provider-agnostic | Configurable per org. |

Sora-class generation is Pro+. Lower-tier plans get static "video stub" previews.

## Music

| Tool | Backend | Notes |
|------|---------|-------|
| `music_gen` | ElevenLabs Music | Royalty-free instrumental tracks up to 4 min. |

Requires `ELEVENLABS_API_KEY`.

## Text-to-speech

| Tool | Backend | Notes |
|------|---------|-------|
| `tts_speak` | ElevenLabs / Voxtral | Streamed via SSE for low first-byte latency. |

Used by [Voice](../features/voice.md). Different from `voice_call` — `tts_speak` is one-shot for a specific message.

## Transcription

| Tool | Backend | Notes |
|------|---------|-------|
| `transcribe_audio` | Voxtral (Mistral) / Azure Speech / Azure Whisper / WhisperX self-hosted / local-whisper (whisper.cpp) | Pick under Admin → Integrations → Transcription |

The default is **Voxtral** (Mistral cloud) — fast, multilingual, cheapest per minute. Switch in **Admin → Integrations → Transcription** (pick the engine in the list, then **Use this provider**).

For audio capture in the chat UI (voice messages, "press to talk"), the in-process **whisper.cpp** path runs entirely on CPU — no GPU, no API key needed. Toggle via `local_whisper_enabled` config.

## Sound effects

| Tool | Backend | Notes |
|------|---------|-------|
| `sound_effect_gen` | ElevenLabs Sound Effects | 10s clips. |

## Agent Search

| Tool | Backend | Notes |
|------|---------|-------|
| `agent_search` | Self-hosted Agent Search service / Cloud-only / Azure Bing | Web search + page fetch + rerank + cleanup. Picked in **Admin → Integrations → Search**. |
| `kb_search` | In-process pgvector / remote search-service | KB-only retrieval. Routed by `kb_provider` admin toggle. |

The cloud-only path runs the entire SERP → fetch → embed → rerank → cleanup loop inside the Node server using your configured providers (Mistral, OpenAI, Azure, Cohere) plus the in-process CPU rerank/embed models — no GPU box required. See [Web search](./web-search.md) for setup and provider comparison.

## Privacy

All AI module outputs go through the Privacy Shield on the way out. Inputs (the prompt you describe) go through too, so generating an image from a prompt with redacted text uses the placeholders ("a sketch of [person_1]'s office").

## Cost

| Module | Approx cost per call |
|--------|----------------------|
| `generate_image` | Google: the provider's rate. Azure: the price per image you entered for the deployment. |
| `video_gen` (Sora-class) | $0.50–2.00 per 6-second clip |
| `music_gen` | $0.30 per minute generated |
| `tts_speak` | $0.05 per minute synthesised |
| `transcribe_audio` | $0.005–0.01 per minute |
| `sound_effect_gen` | $0.01 per clip |

Pricing varies by provider and tier — check the provider's current rates.

### Where image cost shows up

Every generated image writes one row to the AI usage log, from every place that makes images: chat, agents, automations and the icon generator. In **Admin → Monitoring** images count under the **media** area, per person and per model. An Azure image is listed under the model behind the deployment (such as `gpt-image-1.5`).

- **Azure, with a price per image**: the row carries that price, in EUR. Tokens are not rated.
- **Azure, without a price**: the row carries the tokens the API reported, rated like any other model with the model prices in AI Config, your own price overrides included.
- **Google**: logged under the Google model, as before.

The same rows are what the [image limits](../admin/users-and-groups.md#image-limits) count.

## Tier gating

| Module | Min tier |
|--------|----------|
| `agent_search` | Community |
| `generate_image` | Community |
| `tts_speak` | Pro (voice feature) |
| `transcribe_audio` | Pro |
| `music_gen` | Pro |
| `video_gen` | Pro |
| `sound_effect_gen` | Pro |

(Community has limited monthly quota for image gen; Pro+ uses your provider quota.)
