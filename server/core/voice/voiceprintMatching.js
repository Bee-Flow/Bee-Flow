/**
 * Reconcile a pyannoteAI `/identify` result onto a `/diarize` result.
 *
 * WHY THIS EXISTS
 * pyannoteAI cannot transcribe and identify in one job ("Transcription cannot
 * be used with speaker identification jobs yet"), so a meeting runs TWO jobs
 * against the same uploaded audio: `/diarize` produces the speaker-attributed
 * transcript, `/identify` produces name matches. Each job runs its own
 * diarization pass, so `SPEAKER_00` in one is NOT `SPEAKER_00` in the other —
 * the two must be joined on the only thing they provably share: the clock of
 * the single media object both were given.
 *
 * WHAT IT REFUSES TO DO
 * A wrong name is far worse than no name. Words attributed to a colleague who
 * was not in the room is the failure mode this whole module is shaped around,
 * so a match is only PINNED when four independent guards agree. Anything
 * weaker but not implausible becomes a ROSTER hint instead: it is handed to
 * the LLM naming step as a candidate ("one of these people is in the room"),
 * which is the closed-set signal that step is built around, rather than being
 * stamped on a turn as fact.
 *
 * Pure — no I/O, no LLM, no DB — so every decision is unit-testable.
 */

'use strict';

const DEFAULTS = {
    // Below this, pyannote's own similarity score isn't strong enough to name
    // someone. Distinct from the `matching.threshold` we send with the job:
    // that one is pyannote's greedy assignment floor, this is ours.
    minConfidence: Number(process.env.PYANNOTE_IDENTIFY_MIN_CONFIDENCE) || 60,
    // Below this the match is discarded entirely — not even a roster hint.
    weakConfidence: Number(process.env.PYANNOTE_IDENTIFY_WEAK_CONFIDENCE) || 35,
    // Fraction of a diarizer speaker's OWN speaking time that must fall inside
    // the matched person's turns. This is what refuses an ID the diarizer
    // merged from two people: its time is split, so no label reaches 60%.
    minShare: Number(process.env.PYANNOTE_IDENTIFY_MIN_SHARE) || 0.60,
    // Never name a two-second diarization fragment.
    minSeconds: Number(process.env.PYANNOTE_IDENTIFY_MIN_SECONDS) || 8,
    // Winner must beat the runner-up by this much share, or it's a coin flip.
    ambiguityMargin: Number(process.env.PYANNOTE_IDENTIFY_AMBIGUITY_MARGIN) || 0.10,
    // Below this share, a speaker is positively NOT that person (see `ruledOut`).
    // The band between this and `minShare` stays deliberately undecided: a voice
    // the diarizer split can legitimately land there, so it is left to the LLM.
    ruledOutShare: Number(process.env.PYANNOTE_IDENTIFY_RULED_OUT_SHARE) || 0.25,
};

/**
 * @param {Array<{speakerId: string, start: number, end: number}>} diarTurns
 *        Turns from the diarize job (its `output.diarization`, or the mapped
 *        transcript segments when diarization-only rows aren't present).
 * @param {{identification?: Array, voiceprints?: Array}} identifyOutput
 *        Raw `output` of the identify job.
 * @param {Object<string, {name: string, userId?: string}>} labelToName
 *        The opaque labels WE sent (`vp_<uuid>`) → the person behind them.
 *        A label absent from this map is ignored: it is either pyannote's
 *        no-match sentinel or something we never submitted, and in neither
 *        case may it become a name.
 * @param {object} [opts] overrides for DEFAULTS
 * @returns {{
 *   mapping: Object<string, string>,          // diarizer speakerId → display name (confident)
 *   roster: string[],                         // plausible-but-unpinned names, for the LLM
 *   ruledOut: Object<string, string[]>,       // speakerId → names this voice is NOT
 *   matchedIds: string[],                     // voiceprint row ids that produced a pin
 *   detail: Array<{speakerId, label, name, seconds, share, confidence, decision}>,
 * }}
 */
function resolveVoiceprintMapping(diarTurns, identifyOutput, labelToName, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    const empty = { mapping: {}, roster: [], ruledOut: {}, matchedIds: [], detail: [] };

    const turnsIn = Array.isArray(diarTurns) ? diarTurns.filter(t => t && Number(t.end) > Number(t.start)) : [];
    if (!turnsIn.length || !identifyOutput || !labelToName) return empty;

    // ── 1. Which identify-speakers matched a label we actually sent ──
    // `voiceprints[]` is the speaker-level verdict; `confidence` is keyed by
    // label, so the score for a match is confidence[match].
    const confByLabel = new Map();
    const labelByIdentifySpeaker = new Map();
    for (const row of identifyOutput.voiceprints || []) {
        const label = row && row.match;
        if (!label || !labelToName[label]) continue;      // unknown / no-match → ignore
        const conf = Number(row.confidence?.[label]);
        const score = Number.isFinite(conf) ? conf : null;
        // A score below `weakConfidence` is noise; drop the whole row.
        if (score !== null && score < cfg.weakConfidence) continue;
        labelByIdentifySpeaker.set(row.speaker, label);
        const prev = confByLabel.get(label);
        if (prev == null || (score !== null && score > prev)) confByLabel.set(label, score);
    }
    if (labelByIdentifySpeaker.size === 0) return empty;

    // ── 2. Label the identify job's turns ──
    // A per-turn `match` (present with turnLevelConfidence) is the finer
    // signal, so it wins over the speaker-level verdict when it names a label
    // we know.
    const labelledTurns = [];
    for (const t of identifyOutput.identification || []) {
        if (!t) continue;
        const start = Number(t.start) || 0;
        const end = Number(t.end) || 0;
        if (!(end > start)) continue;
        const perTurn = t.match && labelToName[t.match] ? t.match : null;
        const label = perTurn || labelByIdentifySpeaker.get(t.diarizationSpeaker ?? t.speaker) || null;
        if (!label) continue;
        labelledTurns.push({ start, end, speaker: label });
    }
    if (!labelledTurns.length) return empty;

    // ── 3+4. Duration-weighted overlap matrix ──
    //
    // NOT `assignSpeakersByOverlap`: that helper picks ONE winner per segment,
    // which is right for "whose turn is this line" but destroys the very signal
    // needed here. A diarizer id merged from two people would be handed wholly
    // to whichever identified speaker overlapped it marginally more, and would
    // then look 100%-covered — i.e. it would be confidently given the wrong
    // person's name. The real intersection per (diarizer id, label) pair keeps
    // that split visible so the share guard below can refuse it.
    //
    // `total` counts EVERY turn, including ones no label overlapped: without
    // that, a speaker who is 95% unidentified could be named off a 3-second
    // sliver.
    const sortedLabelled = [...labelledTurns].sort((a, b) => a.start - b.start);
    const total = new Map();
    const votes = new Map();
    for (const t of turnsIn) {
        const s = Number(t.start) || 0;
        const e = Number(t.end) || 0;
        const dur = e - s;
        if (!(dur > 0)) continue;
        total.set(t.speakerId, (total.get(t.speakerId) || 0) + dur);
        for (const lt of sortedLabelled) {
            if (lt.start >= e) break;            // sorted — nothing later can overlap
            const inter = Math.min(lt.end, e) - Math.max(lt.start, s);
            if (inter <= 0) continue;
            if (!votes.has(t.speakerId)) votes.set(t.speakerId, new Map());
            const m = votes.get(t.speakerId);
            m.set(lt.speaker, (m.get(lt.speaker) || 0) + inter);
        }
    }

    // ── 5. Decide ──
    const mapping = {};
    const rosterSet = new Set();
    const matchedIds = new Set();
    const detail = [];
    /** diarizer id → (label → share of that speaker's time). Feeds step 6. */
    const shareByDiarId = new Map();

    for (const [diarId, totalSeconds] of total) {
        const m = votes.get(diarId);
        // Recorded even when EMPTY: a speaker no identified voice overlaps at
        // all is the strongest possible "not that person", and step 6 needs to
        // see it. Skipping these early is what let a wholly separate
        // participant stay eligible for an enrolled colleague's name.
        shareByDiarId.set(diarId, new Map(
            [...(m || new Map()).entries()].map(([l, s]) => [l, totalSeconds > 0 ? s / totalSeconds : 0]),
        ));
        if (!m || m.size === 0) continue;

        const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
        const [label, seconds] = ranked[0];
        const runnerUp = ranked[1] ? ranked[1][1] : 0;
        const person = labelToName[label];
        if (!person) continue;

        const share = totalSeconds > 0 ? seconds / totalSeconds : 0;
        const runnerUpShare = totalSeconds > 0 ? runnerUp / totalSeconds : 0;
        const confidence = confByLabel.has(label) ? confByLabel.get(label) : null;

        let decision = 'matched';
        if (confidence !== null && confidence < cfg.minConfidence) decision = 'low_confidence';
        else if (seconds < cfg.minSeconds) decision = 'too_short';
        else if (share < cfg.minShare) decision = 'low_share';
        else if (share - runnerUpShare < cfg.ambiguityMargin) decision = 'ambiguous';

        if (decision === 'matched') {
            mapping[diarId] = person.name;
            if (person.id) matchedIds.add(person.id);
        }

        // Roster: someone who covers a REAL portion of this speaker is plausibly
        // in the room, whether or not they won it. That rescues the merged-id
        // case — two people share one diarizer id, so neither can be pinned, but
        // both belong in the candidate list the LLM works from.
        //
        // The share floor matters: an earlier version admitted any candidate
        // with 8+ seconds of overlap, so a 4% brush against a colleague's voice
        // was promoted to "this person is probably here". That is not evidence
        // of presence, it is evidence of absence.
        for (const [candidateLabel, candidateSeconds] of ranked) {
            const candidateShare = totalSeconds > 0 ? candidateSeconds / totalSeconds : 0;
            if (candidateSeconds < cfg.minSeconds || candidateShare < cfg.ruledOutShare) continue;
            const candidate = labelToName[candidateLabel];
            if (candidate) rosterSet.add(candidate.name);
        }

        detail.push({
            speakerId: diarId,
            label,
            userId: person.userId || null,
            name: person.name,
            seconds: Math.round(seconds * 10) / 10,
            share: Math.round(share * 100) / 100,
            confidence,
            decision,
        });
    }

    const pinned = new Set(Object.values(mapping));

    // ── 6. Negative evidence ──
    //
    // The whole point of this pass. Refusing to pin a speaker is not the same as
    // knowing nothing about them: if we positively located Tom on SPEAKER_01,
    // and SPEAKER_00's speech is only 4% covered by Tom's turns, then SPEAKER_00
    // is NOT Tom. Without this the naming LLM — told "SPEAKER_01 is Tom", "the
    // recorder is Tom", and "several ids mapping to one name is normal" — merged
    // an entire second participant into Tom.
    //
    // Only names PINNED ELSEWHERE are ruled out. If a template was sent but
    // never matched anywhere, we make no negative claim: a weak identify run
    // must never block the LLM from naming that person off an introduction.
    const ruledOut = {};
    for (const [diarId, shares] of shareByDiarId) {
        for (const name of pinned) {
            if (mapping[diarId] === name) continue;      // this speaker IS them
            // Highest share this speaker has against any label bearing that name.
            let best = 0;
            for (const [label, s] of shares) {
                if (labelToName[label]?.name === name && s > best) best = s;
            }
            if (best < cfg.ruledOutShare) {
                if (!ruledOut[diarId]) ruledOut[diarId] = [];
                ruledOut[diarId].push(name);
            }
        }
    }

    return {
        mapping,
        // A name that got pinned somewhere doesn't need to also be a hint.
        roster: [...rosterSet].filter(n => !pinned.has(n)),
        ruledOut,
        matchedIds: [...matchedIds],
        detail,
    };
}

module.exports = { resolveVoiceprintMapping, DEFAULTS };
