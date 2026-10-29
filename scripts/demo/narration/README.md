# Voice candidate for issue #428

Research date: 30 October 2026. This is a prepared candidate, not an accepted
voice or a claim that the three revised scripts sound natural.

## Selection within the existing binding

Use OpenAI `gpt-4o-mini-tts-2025-12-15`, voice `cedar`, speed `1`, through
`/v1/audio/speech`. Keep the managed `VOICE_EXPLAINER_TOKEN` binding and its
speech-only permission. [voice.json](voice.json) owns the exact delivery
instructions. They ask for connected clauses, brief sentence pauses, steady
energy and complete final words. No introduction or extra claims are allowed.

The [official speech guide](https://developers.openai.com/api/docs/guides/text-to-speech)
recommends Cedar or Marin for quality. Cedar is a new candidate against the
preserved Fable take. No listening comparison ran here. Neither preset has a
verified mapping to Dotius's familiar voice. Keep that choice open for Samuel.

This model is a temporary choice, not the quality ceiling. OpenAI's
[deprecation notice](https://developers.openai.com/api/docs/deprecations#2026-10-01-text-to-speech-models)
lists its shutdown on **6 January 2027**. The recommended replacement,
`gpt-realtime-2.1-mini`, uses the Realtime interface. It cannot replace the model
name at the speech endpoint. Stop at that access boundary. Do not broaden the
current binding or silently fall back to another service.

## Current alternatives from official documentation

| Option | Relevant capability | Access decision |
| --- | --- | --- |
| [OpenAI GPT-Realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) | Speech interaction with reasoning and instruction control | Different endpoint; needs approval and an exact-script trial. |
| [OpenAI GPT-Audio-1.5](https://developers.openai.com/api/docs/models/gpt-audio-1.5) | Audio through Chat Completions | Outside the speech-only binding; no call made. |
| [Google Gemini 3.8 Flash TTS](https://ai.google.dev/gemini-api/docs/speech-generation) | Exact-text speech with style and pace controls | Different provider and credentials; no call made. |
| [ElevenLabs Eleven v4](https://elevenlabs.io/docs/overview/models/) | Expressive speech through Text to Dialogue | Different provider and credentials; no call made. |

These are documented capabilities, not measured quality rankings. No supplier,
paid service, key or permission was added. The managed token is absent in this
runtime. Speech generation stops here; local screen proof can still proceed.

## Pacing and next run

1. Use the existing seeds and the three revised shot lists. Record each take
   through `walkthrough.mjs` against a disposable local database.
2. Generate a short synthetic payment candidate with `narrate.mjs` when the
   existing binding is available. Do not use a general-purpose key instead.
3. Listen to the whole take. Check pauses, complete sentences and the words
   against the screen. A duration check cannot judge a voice.
4. If a cue crowds its slot, increase the shot's `hold` and record again.
   Keep speech at speed `1`. Do not clip speech or add empty filler words.
5. Check all three narrated examples. Keep the create-client ending explicit:
   the invoice is ready; it has not been sent.
6. Test play and save in the actual report or attachment client. Name its
   device and version. Show the generated-voice disclosure to viewers.

The runner now accepts holds from 1 to 10 seconds. The old 1.5-second cap
silently defeated longer requested holds. Existing cue ranges still keep each
complete thought in one request; this slice does not prove that separate
requests caused the earlier rhythm problem. The 15–45-second take guard and
the narration duration guard remain in place.

See [the recorded proof and remaining gaps](../../../docs/evidence/narration-428/README.md).
