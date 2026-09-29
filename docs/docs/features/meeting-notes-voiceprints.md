---
sidebar_label: Voice profiles
title: Voice profiles (automatic speaker recognition)
---

# Voice profiles

Meeting Notes normally works out who said what by **reading the transcript**: the AI looks for
introductions ("Ik ben Ewald"), for people being addressed by name, and for the attendee list you
typed in. That works, but it is a guess — and it is made again from scratch for every meeting, even
when it is the same four colleagues every Tuesday.

A **voice profile** replaces that guess with recognition. You record your own voice once; from then
on, any meeting recorded by anyone in your organisation puts your real name on your own turns
automatically, whether or not anyone says it out loud.

:::info Only available with pyannoteAI
Voice profiles use pyannoteAI's speaker-identification model. The feature is completely hidden
unless an administrator has selected **pyannoteAI** as the transcription engine in
*Admin → Integrations → Transcription* and saved an API key. On any other engine, nothing changes.
:::

## Recording yours

*Settings → Preferences → Voice profile → **Record voice profile***.

You are shown a short passage and asked to read it aloud at your normal pace. That is deliberate:
pyannoteAI wants roughly 25 seconds of one clear voice, and left to improvise most people say
"testing, one two" and stop after four. The dialog:

- won't let you stop before **12 seconds** — a clip that short cannot produce a usable profile;
- **stops itself at 28 seconds**, safely under pyannoteAI's 30-second limit;
- shows a live microphone level so you can see it is actually hearing you.

Record somewhere reasonably quiet, with nobody else talking. If a second voice is picked up, or the
clip turns out to be mostly silence, the attempt is refused with an explanation and you can simply
try again.

The **recording itself is never kept**. Only the derived profile — an opaque numeric template — is
stored, encrypted, against your account.

## What it changes in a meeting

When a meeting is transcribed, the audio is uploaded to pyannoteAI once and two jobs run against it
concurrently: one produces the transcript, the other compares the speakers against the voice
profiles of your organisation's members. Names that match confidently are applied directly; anything
less certain is passed to the AI naming step as a *candidate* rather than being stamped on a turn.

The thresholds lean deliberately towards **saying nothing rather than saying the wrong thing**. An
unrecognised speaker shows up as "Spreker 2", exactly as before. A wrong name would attribute
someone's words to a named colleague, which is far worse — so a speaker is only named when the match
is confident, covers most of that speaker's talking time, and is not a close call between two
people.

You can still rename or merge speakers by hand afterwards. A manual correction always wins, and is
never undone by a later re-transcription.

## Privacy

A voice profile is **biometric data** under Article 9 of the GDPR, so it is treated more strictly
than anything else in the product:

| | |
|---|---|
| **Only you can record yours** | There is no endpoint, and no administrator screen, that can create a voice profile for someone else. It can only come from a live microphone session by the account holder. |
| **Separate, explicit consent** | Unticked by default, given per recording, and visible in *Settings → Legal & Consent*. |
| **Withdrawal deletes it** | Withdrawing the consent — or pressing *Delete* — removes the profile immediately. |
| **Nobody can read it** | No API returns the profile, at any privilege level, including super-admin. |
| **Encrypted per organisation** | AES-256-GCM under a key derived for your organisation, so it is meaningless outside it. |
| **Deleted with your account** | Removing the user, or the organisation, removes the profile too. |

People who have **not** recorded a profile are not subject to any extra processing whatsoever: their
speech is separated by speaker exactly as it always was.

## For administrators

*Admin → Integrations → Transcription → pyannoteAI* has two controls:

- **Recognise speakers by voice** — an instance-wide off switch. Turning it off stops identification
  everywhere without anyone having to delete their profile.
- **Match confidence threshold** (default 50) — how sure pyannoteAI must be before a voice counts as
  a candidate at all. Higher means fewer names, but never the wrong one.

Two things worth knowing about cost and scale:

- pyannoteAI cannot transcribe and identify in the same job, so identification submits a **second
  job per meeting**. It is submitted **only when at least one member of that organisation actually
  has a voice profile**, so an organisation where nobody has enrolled pays nothing extra. Because
  both jobs run against a single upload and are polled in parallel, meetings do not take longer.
- A single identification job carries at most **50 profiles**. In a larger organisation the most
  likely 50 are chosen — whoever pressed record, then anyone on the attendee list, then whoever has
  been recognised most recently — and the note says so.

An organisation admin can see **who has enrolled** (names and dates only, never the profiles
themselves) and revoke a profile, which is what offboarding and erasure requests need.

## Self-hosting

If you run Bee Flow yourself and enable this, **you** are the controller for the biometric
processing and need your own agreement with pyannoteAI. The consent flow is identical to the cloud.
See [environment variables](../self-hosting/env.md) for the thresholds and limits you can tune.
