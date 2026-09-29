---
title: AI modules
---

# AI modules

Built-in AI capabilities exposed as tools — image generation, video generation, music, TTS, transcription, and the local agent-search engine. No external OAuth required; gated only by the corresponding API keys you set in `.env`.

## Image generation

| Tool | Backend | Notes |
|------|---------|-------|
| `image_gen` | Google Veo (default) | Photorealistic + illustration styles. |

Set `GOOGLE_VEO_API_KEY` (or your provider). Generated images are stored short-term in Bee Flow's blob store and served via signed URLs that expire in 24h. Add to a Knowledge Base or upload to Files for permanent storage.

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
| `transcribe_audio` | Voxtral (Mistral) / Azure Speech / Azure Whisper / WhisperX self-hosted / local-whisper (whisper.cpp) | Pick under Admin → Integrations → Voice |

The default is **Voxtral** (Mistral cloud) — fast, multilingual, cheapest per minute. Switch in **Admin → Integrations → Voice → Active Provider**.

For audio capture in the chat UI (voice messages, "press to talk"), the in-process **whisper.cpp** path runs entirely on CPU — no GPU, no API key needed. Toggle via `local_whisper_enabled` config.

## Sound effects

| Tool | Backend | Notes |
|------|---------|-------|
| `sound_effect_gen` | ElevenLabs Sound Effects | 10s clips. |

## Agent Search

| Tool | Backend | Notes |
|------|---------|-------|
| `agent_search` | Self-hosted Agent Search service / Cloud-only / Azure Bing | Web search + page fetch + rerank + cleanup. Picked in **Admin → Integrations → Zoeken**. |
| `kb_search` | In-process pgvector / remote search-service | KB-only retrieval. Routed by `kb_provider` admin toggle. |

The cloud-only path runs the entire SERP → fetch → embed → rerank → cleanup loop inside the Node server using your configured providers (Mistral, OpenAI, Azure, Cohere) plus the in-process CPU rerank/embed models — no GPU box required. See [Web search](./web-search.md) for setup and provider comparison.

## Privacy

All AI module outputs go through the Privacy Shield on the way out. Inputs (the prompt you describe) go through too, so generating an image from a prompt with redacted text uses the placeholders ("a sketch of [person_1]'s office").

## Cost

| Module | Approx cost per call |
|--------|----------------------|
| `image_gen` (Veo) | $0.02–0.10 |
| `video_gen` (Sora-class) | $0.50–2.00 per 6-second clip |
| `music_gen` | $0.30 per minute generated |
| `tts_speak` | $0.05 per minute synthesised |
| `transcribe_audio` | $0.005–0.01 per minute |
| `sound_effect_gen` | $0.01 per clip |

Pricing varies by provider and tier — check the provider's current rates.

## Tier gating

| Module | Min tier |
|--------|----------|
| `agent_search` | Community |
| `image_gen` | Community |
| `tts_speak` | Pro (voice feature) |
| `transcribe_audio` | Pro |
| `music_gen` | Pro |
| `video_gen` | Pro |
| `sound_effect_gen` | Pro |

(Community has limited monthly quota for image gen; Pro+ uses your provider quota.)
