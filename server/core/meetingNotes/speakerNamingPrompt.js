// @typecheck strict
/**
 * The prompt of the speaker-naming call (./speakerNaming.js): the per-ID
 * speaking list, the voiceprint facts and exclusions, the speaker count, the
 * roster line, the rules (closed attendee set or not) and the system prompt
 * that puts them together. Pure: strings in, strings out.
 */

'use strict';

const { formatTime } = require('./transcriptArtifacts');
const { GAP_MARKER } = require('./transcriptExcerpt');

/**
 * Per-ID: how long it speaks, and which names appear in its OWN turns. The
 * second part is the raw material for "this ID might be this person".
 * @param {Array<{id:string, speakingSeconds?:number, segments?:number}>} rows
 * @param {any} evidence
 */
function speakerListOf(rows, evidence) {
    return rows
        .map((r) => {
            const parts = [r.id];
            if (typeof r.speakingSeconds === 'number') {
                parts.push(`(speaks ${formatTime(r.speakingSeconds)}${r.segments ? `, ${r.segments} turns` : ''})`);
            }
            const names = evidence?.namesBySpeaker?.[r.id];
            if (names?.length) parts.push(`— names occurring in its own turns: ${names.join(', ')}`);
            return parts.join(' ');
        })
        .join('\n');
}

/**
 * The hint lines: the recorder, the voiceprint facts (locked) and exclusions
 * (ruled out), and the speaker count.
 * @param {{ userName?: string|null, lockedNames: Object<string,string>|null,
 *           ruledOutNames: Object<string,string[]>|null, rows: Array<{id:string}>,
 *           expectedSpeakers: number|null }} p
 */
function hintsOf({ userName, lockedNames, ruledOutNames, rows, expectedSpeakers }) {
    const userHint = userName
        ? `\n\nSTRONG HINT: The person who recorded this meeting is named "${userName}". They are almost certainly one of the speakers.`
        : '';
    // Facts, not hints: these came from a voice match, not from the text.
    const lockedHint = lockedNames
        ? `\n\nALREADY IDENTIFIED BY VOICEPRINT — these are certain, do not re-assign them:\n`
            + Object.entries(lockedNames).map(([id, name]) => `- ${id} = ${name}`).join('\n')
            + `\nThose people are definitely in the room; use that when working out who the remaining IDs are.`
        : '';
    // The negative half of the same evidence. Enforced after the reply too
    // (speakerNaming.js) — this only helps the model get it right first time.
    const ruledOutHint = ruledOutNames
        ? `\n\nRULED OUT BY VOICEPRINT — their voice was compared and does NOT match:\n`
            + Object.entries(ruledOutNames)
                .filter(([id]) => rows.some(r => r.id === id))
                .map(([id, names]) => `- ${id} is NOT ${names.join(', and NOT ')}`)
                .join('\n')
            + `\nThese are different people. Never assign them one of those names, however much the dialogue seems to suggest it.`
        : '';
    // The user told us how many people are in the room. Say so plainly —
    // otherwise the only count-related pressure in this prompt is the
    // "diarization is noisy, expect FEWER people than ids" warning, which on
    // its own encourages collapsing distinct participants.
    const countHint = expectedSpeakers
        ? `\n\nSPEAKER COUNT: there are exactly ${expectedSpeakers} distinct ${expectedSpeakers === 1 ? 'person' : 'people'} in this meeting — no more, no fewer.`
        : '';
    return `${userHint}${lockedHint}${ruledOutHint}${countHint}`;
}

/**
 * The roster line: a closed attendee set, or the names people used.
 * @param {string[]} callerRoster
 * @param {string[]} candidateRoster
 */
function rosterHintOf(callerRoster, candidateRoster) {
    if (callerRoster.length) {
        return `\n\nATTENDEE LIST — THIS IS THE COMPLETE SET OF PEOPLE IN THE ROOM: ${callerRoster.join(', ')}.
Every speaker ID belongs to one of these ${callerRoster.length} people. There are no others.`;
    }
    return candidateRoster.length
        ? `\n\nNAMES PEOPLE USED IN THIS MEETING: ${candidateRoster.join(', ')}. Some may be people who were only talked ABOUT and never spoke — use a name only where the dialogue shows that person is actually speaking.`
        : '';
}

/**
 * Rules depend on whether we have a closed attendee set. With one, assign
 * every ID. Without one, name only the IDs the dialogue clearly identifies and
 * OMIT the rest — the caller's floor gives those clean generic labels, so
 * "nobody introduced themselves" degrades to tidy "Spreker N" instead of a
 * hallucinated name.
 * @param {string[]} callerRoster
 * @param {Object<string,string[]>|null} ruledOutNames
 */
function rulesOf(callerRoster, ruledOutNames) {
    const sameNameRule = ruledOutNames
        ? ' — EXCEPT where a "RULED OUT" line above forbids that pairing, which always wins'
        : '';
    return callerRoster.length
        ? `Rules:
1. Every speaker_ID belongs to one of the attendees above — assign each ID to the most likely attendee using the dialogue.
2. Multiple IDs mapping to the SAME attendee is normal and expected (the diarizer splits one voice across IDs)${sameNameRule}.
3. Do not invent names outside the attendee list. If an ID is ambiguous, pick the most plausible attendee anyway.`
        : `Rules:
1. Map a speaker_ID to a person's real first name ONLY when the dialogue clearly identifies them: they introduce themselves ("Ik ben Ewald", "Mijn naam is Tom") or are addressed by name and answer.
2. Multiple IDs mapping to the SAME name is normal and expected (the diarizer splits one voice across IDs)${sameNameRule}.
3. If you cannot confidently name an ID, OMIT it from the JSON entirely. NEVER invent a name, and NEVER output a generic label like "Speaker A" or "Spreker 1" — omission is the correct answer for an unidentified speaker.`;
}

/**
 * The system prompt, from the rules, the hint lines and the roster line.
 * @param {{ idCount: number, rules: string, hints: string, rosterHint: string }} p
 */
function namingSystemPrompt({ idCount, rules, hints, rosterHint }) {
    // Lines separated by the gap marker are NOT adjacent — don't infer
    // identity from their adjacency.
    const excerptHint = `\n\nThe transcript below may be an EXCERPT of a longer meeting. Lines separated by "${GAP_MARKER}" are NOT adjacent turns — passages between them were omitted, so never infer identity from their adjacency.`;
    return `You are a transcript analyst. Work out which real person each diarized speaker ID belongs to.

CRITICAL — Speaking vs. Being Mentioned:
- A person SPEAKS if they introduce themselves, or answer when addressed ("Tom, wat denk jij?" → the next turn is likely Tom).
- A person is merely MENTIONED when others talk ABOUT them in the third person. Being mentioned does NOT make someone a speaker.
- Judge introductions from meaning, not phrasing: "Ik ben Ewald" introduces Ewald, "Ik ben benieuwd" introduces nobody, "Dit is Ewald" introduces someone else.

DIARIZATION IS NOISY:
The diarizer splits ONE person across MANY IDs, so several IDs mapping to the same name is normal — a ${idCount}-ID transcript is not a ${idCount}-person meeting. An ID that speaks only a few seconds is usually a fragment of a neighbouring turn.

${rules}${hints}${rosterHint}${excerptHint}

Return ONLY a JSON object mapping speaker IDs to real names, e.g. {"SPEAKER_00": "Tom", "SPEAKER_02": "Gerard"}. Omit IDs you cannot name. No explanation, no markdown, ONLY valid JSON.`;
}

module.exports = { speakerListOf, hintsOf, rosterHintOf, rulesOf, namingSystemPrompt };
