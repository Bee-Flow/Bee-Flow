---
title: Voice
---

# Voice

:::warning[Enterprise feature]

Requires an Enterprise licence key (`voice_chat`). See [Free vs paid features](../getting-started/tiers.md).

:::

Bee Flow supports natural full-duplex voice conversations. You speak; the assistant speaks back; either side can interrupt.

## Two modes

| Mode | UX |
|------|----|
| **Push-to-talk** | Click & hold the microphone in the chat composer. Release to send. The transcript is submitted as the next message. |
| **Voice call** | Click **Voice call** in the chat header. The microphone stays open. The assistant detects when you stop and replies; you can interrupt mid-reply. |

Voice call is the more interesting mode — most users land here after trying push-to-talk.

![Voice call active state](../img/screenshots/features/voice-call-active/)

## Voice call state machine

```
       ┌──────────┐
       │  IDLE    │  (after clicking "Voice call", before first speech)
       └────┬─────┘
            │ speech detected (energy > threshold)
            ▼
       ┌──────────┐
       │LISTENING │  (recording, VAD watching)
       └────┬─────┘
            │ silence > 900 ms, utterance ≥ 400 ms
            ▼
       ┌──────────┐
       │THINKING  │  (STT + agent + first TTS chunk)
       └────┬─────┘
            │ first audio chunk arrives
            ▼
       ┌──────────┐
       │SPEAKING  │  (playing TTS audio)
       └────┬─────┘
            │ done OR user interrupts (energy spike)
            ▼
       (back to IDLE / LISTENING)
```

## Voice Activity Detection (VAD)

The VAD is energy-based, with hysteresis to prevent oscillation:

| Constant | Default | Purpose |
|----------|--------:|---------|
| `VAD_SPEECH_RMS` | 0.018 | Start-of-speech threshold |
| `VAD_SILENCE_RMS` | 0.012 | End-of-speech threshold (lower = hysteresis) |
| `VAD_SILENCE_MS` | 900 | Trailing silence to end a turn |
| `VAD_MIN_UTTERANCE_MS` | 400 | Discard clips shorter than this (eats stray clicks) |
| `VAD_MAX_UTTERANCE_MS` | 30 000 | Hard cap at 30 seconds |
| `VAD_FFT_SIZE` | 1024 | Audio analysis block size |
| `VAD_POLL_MS` | 50 | Evaluate energy 20× per second |

These tune well for typical office environments. In noisier rooms, raise `VAD_SPEECH_RMS`. With high-quality directional mics, lower it.

## Barge-in

While the assistant speaks, the mic stays open. If the user starts speaking (energy spike), playback is interrupted immediately and a new turn begins. This simulates natural phone-conversation flow.

## Provider routing

| Direction | Provider | Notes |
|-----------|----------|-------|
| Speech → text (STT) | **Voxtral** (default) | Multilingual. Returns detected language with each turn. |
| | Deepgram (`DEEPGRAM_API_KEY`) | Alternative if you don't want Voxtral. |
| | Mistral Transcription (`MISTRAL_TRANSCRIPTION_KEY`) | EU-region option. |
| Text → speech (TTS) | **Voxtral** (default) | Streams chunks for low first-byte latency. |
| | ElevenLabs (`ELEVENLABS_API_KEY`) | Higher voice fidelity, more languages. |
| Local STT | Whisper (`OLLAMA_BASE_URL` + a Whisper model) | Fully offline option. |

Switch provider in **Settings → Organisation → Voice**. Per-user voice (e.g. one Talk room uses a Dutch voice, another an English voice) is on the roadmap.

## Sticky language

The first turn's detected language is cached as `stickyLanguageRef` for the session. Short utterances ("yes", "no") are notoriously hard to language-detect; sticking to the previous language prevents jarring mid-call language flips.

## Browser support

Requires `getUserMedia` (WebRTC) and the Web Audio API:

| Browser | Support |
|---------|:-------:|
| Chrome 80+ | ✅ |
| Edge 80+ | ✅ |
| Firefox 75+ | ✅ |
| Safari 14+ | ✅ |
| Mobile Safari (iOS 14+) | ✅ |
| Mobile Chrome (Android) | ✅ |

The first time the user clicks **Voice call**, the browser asks for microphone permission. If denied, the button shows a permission-error tooltip.

## Latency

Typical end-to-end latency from end-of-utterance to first audio chunk:

| Layer | Time |
|-------|------|
| STT | 200–400 ms |
| LLM first token | 300–800 ms (model-dependent) |
| TTS first chunk | 150–300 ms |
| **Total** | **0.7 – 1.5 s** |

The `THINKING` state shows a spinning bee animation so the user has feedback during the gap.

## Privacy

The Privacy Shield runs on the **transcribed text** before it reaches the model — exactly the same as text chat. Voice inputs are not retained beyond session lifetime unless you explicitly enable **conversation history** for voice calls (off by default).

Audio bytes never hit the LLM provider — only transcripts do.

## Server endpoint

Internally the SPA POSTs to `/api/voice/turn` with the recorded blob and recent message history. The server orchestrates STT → guardrails → agent → TTS and streams back.

## Where to next

- [Voice profiles](meeting-notes-voiceprints.md) — recognising *who* is speaking in Meeting Notes, not just what was said.
- [Privacy shield](privacy-shield.md) — what's redacted from voice transcripts.
- [API → Streaming (SSE)](../api/sse.md) — same event protocol used for voice TTS chunks.
