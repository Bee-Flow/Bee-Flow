// @typecheck
/**
 * Hybrid speaker-naming evidence: local NER extracts, the LLM judges.
 *
 * WHY THE SPLIT
 * Working out who each diarizer ID belongs to is two jobs wearing one coat:
 *   1. "Where are person names spoken, and what are they?" — extraction. A NER
 *      model answers this; no pattern list required.
 *   2. "Is that line an introduction, and which ID is which person?" —
 *      judgement. Only the LLM can read "Ik ben Ewald" vs "Ik ben benieuwd" vs
 *      "Dit is Ewald" vs "Met Ewald" without someone enumerating phrasings.
 *
 * This module does (1) and nothing else. An earlier version matched
 * `ik ben|mijn naam is|I am|…` here to pre-extract introductions, which put
 * judgement in the extraction layer and inherited every weakness of a
 * hand-written pattern list: it missed "Ik heet X", "X hier", ASR variants, and
 * any language nobody thought to add. The point of using NER was to stop
 * hand-writing patterns.
 *
 * Everything degrades to null: the guard is an optional sidecar, and a meeting
 * must never fail to transcribe because the name detector was unavailable.
 */

const { speakerOf } = require('./transcriptExcerpt');
const log = require('../../telemetry/log');

const PERSON_CATEGORY = 'Person';
const CONFIDENCE = 0.7;

/**
 * Find person names in a transcript and attribute them to the segment (and
 * therefore the speaker ID) that said them.
 *
 * @param {Array<{speakerId: string, text: string}>} segments  Renamed/merged segments.
 * @param {{text: string, offsets: Array<{start: number, end: number, bodyStart?: number}>}} rendered
 *        The formatted transcript plus each segment's char range within it —
 *        produced while formatting, so nothing has to be parsed back out.
 * @param {function} detectPii  Injected for testability:
 *        (text, categories, threshold) → { entities, degraded } | null
 * @returns {Promise<null|{
 *   roster: string[],
 *   namesBySpeaker: Object<string, string[]>,
 *   nameLines: number[],
 * }>} null when no detection is available — callers fall back to LLM-only naming.
 */
async function extractSpeakerEvidence(segments, rendered, detectPii) {
    if (!rendered || !rendered.text || !rendered.text.trim()) return null;

    let result;
    try {
        result = await detectPii(rendered.text, [PERSON_CATEGORY], CONFIDENCE);
    } catch (err) {
        // detectPii already swallows guard errors; belt and braces, because a
        // naming aid must never take a transcription down with it.
        log.warn('[SpeakerEvidence] person detection threw, continuing without it:', err.message);
        return null;
    }

    // null      = guard not installed (endpoint unconfigured)
    // degraded  = installed but unreachable
    // Either way there is nothing to fail closed about: worst case the LLM names
    // speakers exactly as it did before this existed.
    if (!result || result.degraded) {
        log.info(
            `[SpeakerEvidence] no person detection available (${result ? result.degradedReason : 'guard not configured'})`
            + ' — falling back to LLM-only speaker naming'
        );
        return null;
    }

    const entities = (result.entities || []).filter(
        e => e && e.category === PERSON_CATEGORY && typeof e.offset === 'number'
    );

    const nameLines = new Set();
    const roster = new Set();
    const namesBySpeaker = {};

    for (const entity of entities) {
        const idx = segmentAt(rendered.offsets, entity.offset);
        if (idx === -1) continue;
        // Inside the "[Speaker] MM:SS - MM:SS: " prefix, not in what was said.
        // See the bodyStart note in renderTranscript.
        const bodyStart = rendered.offsets[idx].bodyStart;
        if (typeof bodyStart === 'number' && entity.offset < bodyStart) continue;

        const name = entity.text.trim();
        if (!name) continue;

        roster.add(name);
        nameLines.add(idx);

        // Which names appear in a given ID's OWN turns. That's the raw signal
        // for "this ID might be this person" — the LLM decides whether it's a
        // self-introduction, someone being addressed, or third-person mention.
        const speakerId = speakerOf(segments[idx]);
        if (speakerId) {
            if (!namesBySpeaker[speakerId]) namesBySpeaker[speakerId] = new Set();
            namesBySpeaker[speakerId].add(name);
        }
    }

    return {
        roster: [...roster],
        namesBySpeaker: Object.fromEntries(
            Object.entries(namesBySpeaker).map(([id, names]) => [id, [...names]])
        ),
        nameLines: [...nameLines].sort((a, b) => a - b),
    };
}

/** Index of the segment whose char range contains `offset`, or -1. */
function segmentAt(offsets, offset) {
    let lo = 0, hi = offsets.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (offset < offsets[mid].start) hi = mid - 1;
        else if (offset >= offsets[mid].end) lo = mid + 1;
        else return mid;
    }
    return -1;
}

module.exports = { extractSpeakerEvidence };
