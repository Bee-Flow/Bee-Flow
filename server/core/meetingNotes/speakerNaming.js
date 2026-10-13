// @typecheck
/**
 * Speaker naming: diarizer speaker ids -> real names (hybrid NER + LLM).
 *
 * Split out of `summaryHelpers.js`, which re-exports `identifySpeakerNames`.
 * Holds the generic-label detector, the guard-free introduced-name pass and
 * the naming call itself; the model tier and name coercion come from
 * `summaryLlm.js`, so naming and the artifact pass agree on both.
 */

const llmClient = require('../llm/llmClient');
const { formatTime } = require('./transcriptArtifacts');
const { renderTranscript, buildSpeakerNamingExcerpt, GAP_MARKER } = require('./transcriptExcerpt');
const { extractSpeakerEvidence } = require('./speakerEvidence');
const { parseJsonArray, parseJsonObject } = require('./llmJson');
const { MEETING_LLM_TIMEOUT_MS, resolveSmartModel, coerceName } = require('./summaryLlm');
const log = require('../../telemetry/log');

/**
 * True for values that are NOT a real person name — hedges ("unknown"), the
 * word for a generic speaker in any supported language ("Speaker 1", "Spreker
 * 2", "SPEAKER_00", "Sprecher"), or the id echoed back. Used to drop such
 * answers from the LLM mapping so the id falls to fillGenericSpeakerLabels
 * instead of persisting a hallucinated or raw label.
 */
function looksGenericSpeakerName(value) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return true;
    if (/^(unknown|null|none|n\/?a|onbekend|guest|gast)$/i.test(v)) return true;
    // "Speaker", "Speaker 1", "Speaker A", "SPEAKER_00", "Spreker 2", "Sprecher", …
    if (/^(speaker|spreker|sprecher|intervenant|interlocutor(?:e)?|orador|guest|gast)[\s_-]*[a-z0-9]*$/i.test(v)) return true;
    return false;
}

/**
 * Guard-free substitute for the GLiNER name extractor: ask the LLM which first
 * names people actually USED TO INTRODUCE THEMSELVES (or were addressed by and
 * answered), ignoring anyone merely talked about. Returns the candidate roster
 * that turns open-ended naming into closed-set assignment when no attendee list
 * and no PII-guard are available. Best-effort — returns [] on any failure.
 */
async function extractIntroducedNames(excerpt, language, modelId, userName) {
    try {
        const systemPrompt = `You are analysing a meeting transcript. List the FIRST NAMES of the people who are ACTUALLY SPEAKING in it.
Include a name ONLY when the dialogue shows that person speaks — they introduce themselves ("Ik ben Ewald", "Mijn naam is Tom", "Tom hier") or are addressed by name and answer in the next turn.
Do NOT include names of people who are only talked ABOUT in the third person, and do NOT invent names.
If nobody clearly identifies themselves, return an empty array.
Return ONLY a JSON array of first names, e.g. ["Tom","Gerard"]. No explanation, no markdown.`;
        const userMsg = (userName ? `The person who recorded this meeting is named "${userName}" and is almost certainly one of the speakers.\n\n` : '')
            + `Language: ${language}\n\nTranscript:\n${excerpt}`;
        const result = await llmClient.chat(modelId, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMsg },
        ], { maxTokens: 256, temperature: 0, timeoutMs: MEETING_LLM_TIMEOUT_MS });
        const parsed = parseJsonArray((result.content || '').trim());
        const raw = parsed && Array.isArray(parsed.value) ? parsed.value : [];
        const names = [...new Set(raw
            .map(n => String(n || '').trim())
            .filter(n => n && n.length <= 40 && !looksGenericSpeakerName(n)))];
        if (names.length) log.info(`[Transcriptions] introduced-name extraction via ${modelId}:`, names);
        return names;
    } catch (err) {
        log.warn('[Transcriptions] introduced-name extraction failed:', err.message);
        return [];
    }
}

/**
 * Map diarizer speaker IDs to real names — hybrid NER + LLM.
 *
 * Two jobs, split by what each tool is actually good at:
 *   1. The guard's GLiNER `Person` tier extracts the names and where they occur.
 *   2. The fast-tier LLM does the judgement: whether a name is an introduction
 *      or a mention, which ID is which person, and which IDs are one voice the
 *      diarizer split apart.
 *
 * `participantNames` is what makes this work. With a known attendee list the
 * task becomes assignment onto a closed set ("each ID is one of these six"),
 * which is answerable. Without one it is open-ended voice clustering from text,
 * which is not — and the model responds by inventing a label per unknown ID
 * ("Speaker A".."Speaker Y"). Talk and Meet supply a roster automatically;
 * manual uploads take one from the Attendees field.
 *
 * The transcript is passed through an evidence-driven excerpt, not truncated: a
 * prefix cut one real meeting at ~39 minutes and discarded its introduction
 * round at 52:33.
 *
 * Degrades cleanly: with no guard installed, naming behaves as it did before.
 *
 * `opts.lockedNames` carries IDs already identified ACOUSTICALLY by a
 * pyannoteAI voiceprint. Those are evidence, not inference, so they are never
 * put to the model: they are removed from the open set, stated as facts in the
 * prompt (knowing SPEAKER_00 is Tom means "Tom, wat denk jij?" is answered by
 * someone else), and re-applied after the model's reply is sanitised.
 *
 * `opts.ruledOutNames` is the same evidence with the opposite sign, and it
 * matters just as much: a speaker whose voice was compared against Tom's
 * template and covered 4% is NOT Tom. Without it, every other pressure in this
 * prompt — "SPEAKER_01 is Tom", "the recorder is Tom", "several ids mapping to
 * one name is normal" — pushed the model into merging a whole second
 * participant into the one enrolled colleague.
 *
 * @param {Array} segments Structured segments ({speaker,start,end,text}).
 * @param {{lockedNames?: Object<string,string>,
 *          ruledOutNames?: Object<string,string[]>,
 *          expectedSpeakers?: number|null}} [opts]
 */
async function identifySpeakerNames(segments, speakerIds, language, userName, userOrgId = null, participantNames = [], opts = {}) {
    const lockedNames = opts && opts.lockedNames && Object.keys(opts.lockedNames).length ? opts.lockedNames : null;
    const ruledOutNames = opts && opts.ruledOutNames && Object.keys(opts.ruledOutNames).length ? opts.ruledOutNames : null;
    const expectedSpeakers = Number(opts?.expectedSpeakers) >= 1 ? Math.round(Number(opts.expectedSpeakers)) : null;

    /** Is `name` acoustically excluded for `id`? Trimmed, case-insensitive. */
    const isRuledOut = (id, name) => {
        const banned = ruledOutNames && ruledOutNames[id];
        if (!banned || !banned.length) return false;
        const v = String(name || '').trim().toLowerCase();
        return banned.some(b => String(b).trim().toLowerCase() === v);
    };

    try {
        // Naming is Dutch identity-resolution, not a cheap classification — it
        // ran on the fast tier and hedged. Use the smart tier (the summary tier).
        const modelId = await resolveSmartModel(userOrgId);

        // Render once, keeping each segment's char range. Everything downstream
        // works off structure and arithmetic — nothing re-parses this text.
        const rendered = renderTranscript(segments, formatTime);

        // ── Step 1: name evidence (optional GLiNER sidecar) ──
        // The PII guard says what the names are and where. It is OPTIONAL: when
        // it's unreachable `evidence` is null, and we fall back to an LLM
        // extraction pass below instead of naming blind.
        const { detectPii } = require('../privacy/piiDetection');
        const evidence = await extractSpeakerEvidence(segments, rendered, detectPii);

        // Callers may pass bare IDs or the richer `{id, speakingSeconds,
        // segments}` rows they already build for the speaker stats panel. The
        // durations matter: they're what lets the model tell a real
        // participant from a two-second diarization fragment.
        const allRows = (Array.isArray(speakerIds) ? speakerIds : [])
            .map(s => (typeof s === 'string' ? { id: s } : s))
            .filter(s => s && s.id);

        // Voiceprint-identified IDs are settled. Ask the model only about the
        // rest — and when there is no rest, skip the whole naming step: no
        // guard call, no excerpt build, no smart-tier LLM round trip. A team
        // where everyone has enrolled therefore drops the single most
        // expensive stage of the pipeline.
        const rows = lockedNames ? allRows.filter(r => !lockedNames[r.id]) : allRows;
        if (lockedNames && rows.length === 0) {
            log.info(`[Transcriptions] all ${allRows.length} speaker id(s) identified by voiceprint — skipping LLM naming`);
            return { ...lockedNames };
        }

        // Per-ID: how long it speaks, and which names appear in its OWN turns.
        // The second part is the raw material for "this ID might be this person".
        const speakerList = rows
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
        // (see below) — this only helps the model get it right first time.
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
        // "diarization is noisy, expect FEWER people than ids" warning below,
        // which on its own encourages collapsing distinct participants.
        const countHint = expectedSpeakers
            ? `\n\nSPEAKER COUNT: there are exactly ${expectedSpeakers} distinct ${expectedSpeakers === 1 ? 'person' : 'people'} in this meeting — no more, no fewer.`
            : '';

        // The excerpt is assembled (not a blind prefix) so the introduction round
        // is present even in long meetings. Build it before naming so the
        // guard-free extraction pass reads the same text.
        const { excerpt, stats } = buildSpeakerNamingExcerpt(segments, rendered.lines, {
            nameLines: evidence?.nameLines,
        });

        // Roster precedence: caller-supplied attendees (authoritative closed set)
        // ▸ guard-detected names ▸ an LLM extraction of who introduced themselves.
        // The last is the guard-free substitute that keeps naming working on
        // boxes without GLiNER — the exact case that left everyone as SPEAKER_0N.
        const suppliedRoster = Array.isArray(participantNames) ? participantNames.filter(Boolean) : [];
        const lockedList = lockedNames ? [...new Set(Object.values(lockedNames))] : [];
        // Voiceprint names join the CLOSED set only when the caller already
        // supplied one. On their own they prove who IS present, never that
        // nobody else is — so without an attendee list they go in as candidate
        // names, which makes no completeness claim the model could over-apply.
        const callerRoster = suppliedRoster.length
            ? [...new Set([...suppliedRoster, ...lockedList])]
            : [];
        const detectedRoster = evidence?.roster || [];
        let extractedRoster = [];
        if (!callerRoster.length && !detectedRoster.length && !lockedList.length) {
            extractedRoster = await extractIntroducedNames(excerpt, language, modelId, userName);
        }
        const candidateRoster = [...new Set([
            ...lockedList,
            ...(detectedRoster.length ? detectedRoster : extractedRoster),
        ])];

        const rosterHint = callerRoster.length
            ? `\n\nATTENDEE LIST — THIS IS THE COMPLETE SET OF PEOPLE IN THE ROOM: ${callerRoster.join(', ')}.
Every speaker ID belongs to one of these ${callerRoster.length} people. There are no others.`
            : (candidateRoster.length
                ? `\n\nNAMES PEOPLE USED IN THIS MEETING: ${candidateRoster.join(', ')}. Some may be people who were only talked ABOUT and never spoke — use a name only where the dialogue shows that person is actually speaking.`
                : '');

        // Rules depend on whether we have a closed attendee set. With one, assign
        // every ID. Without one, name only the IDs the dialogue clearly
        // identifies and OMIT the rest — the caller's floor gives those clean
        // generic labels, so "nobody introduced themselves" degrades to tidy
        // "Spreker N" instead of a hallucinated name.
        const sameNameRule = ruledOutNames
            ? ' — EXCEPT where a "RULED OUT" line above forbids that pairing, which always wins'
            : '';
        const rules = callerRoster.length
            ? `Rules:
1. Every speaker_ID belongs to one of the attendees above — assign each ID to the most likely attendee using the dialogue.
2. Multiple IDs mapping to the SAME attendee is normal and expected (the diarizer splits one voice across IDs)${sameNameRule}.
3. Do not invent names outside the attendee list. If an ID is ambiguous, pick the most plausible attendee anyway.`
            : `Rules:
1. Map a speaker_ID to a person's real first name ONLY when the dialogue clearly identifies them: they introduce themselves ("Ik ben Ewald", "Mijn naam is Tom") or are addressed by name and answer.
2. Multiple IDs mapping to the SAME name is normal and expected (the diarizer splits one voice across IDs)${sameNameRule}.
3. If you cannot confidently name an ID, OMIT it from the JSON entirely. NEVER invent a name, and NEVER output a generic label like "Speaker A" or "Spreker 1" — omission is the correct answer for an unidentified speaker.`;

        // Lines separated by the gap marker are NOT adjacent — don't infer
        // identity from their adjacency.
        const excerptHint = `\n\nThe transcript below may be an EXCERPT of a longer meeting. Lines separated by "${GAP_MARKER}" are NOT adjacent turns — passages between them were omitted, so never infer identity from their adjacency.`;

        const systemPrompt = `You are a transcript analyst. Work out which real person each diarized speaker ID belongs to.

CRITICAL — Speaking vs. Being Mentioned:
- A person SPEAKS if they introduce themselves, or answer when addressed ("Tom, wat denk jij?" → the next turn is likely Tom).
- A person is merely MENTIONED when others talk ABOUT them in the third person. Being mentioned does NOT make someone a speaker.
- Judge introductions from meaning, not phrasing: "Ik ben Ewald" introduces Ewald, "Ik ben benieuwd" introduces nobody, "Dit is Ewald" introduces someone else.

DIARIZATION IS NOISY:
The diarizer splits ONE person across MANY IDs, so several IDs mapping to the same name is normal — a ${rows.length}-ID transcript is not a ${rows.length}-person meeting. An ID that speaks only a few seconds is usually a fragment of a neighbouring turn.

${rules}${userHint}${lockedHint}${ruledOutHint}${countHint}${rosterHint}${excerptHint}

Return ONLY a JSON object mapping speaker IDs to real names, e.g. {"SPEAKER_00": "Tom", "SPEAKER_02": "Gerard"}. Omit IDs you cannot name. No explanation, no markdown, ONLY valid JSON.`;

        log.info(
            `[Transcriptions] naming excerpt: ${stats.kept}/${stats.total} chars`
            + (stats.truncated
                ? `, ${stats.lines}/${stats.totalLines} lines, ${stats.speakersCovered}/${stats.speakersTotal} ids`
                : ' (full)')
            + `, roster: ${callerRoster.length ? `${callerRoster.length} (attendees)` : (detectedRoster.length ? `${detectedRoster.length} (detected)` : `${extractedRoster.length} (extracted)`)}`
            + (lockedNames ? `, ${Object.keys(lockedNames).length} id(s) pinned by voiceprint` : '')
        );

        const result = await llmClient.chat(modelId, [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: `Speaker IDs (${rows.length}) and how long each one speaks:\n${speakerList}\n\n`
                    + `Language: ${language}\n\nTranscript:\n${excerpt}`,
            },
            // The reply is one JSON entry per ID. A truncated reply fails to
            // parse and costs us the whole mapping, so scale the ceiling with
            // the roster instead of a fixed 512.
        ], { maxTokens: Math.max(512, rows.length * 40), temperature: 0, timeoutMs: MEETING_LLM_TIMEOUT_MS });

        const parsed = parseJsonObject((result.content || '').trim());
        if (parsed) {
            const mapping = parsed.value;
            // Drop hedges and any generic / self-referential label the model may
            // still emit. Those IDs are left unmapped on purpose so the caller's
            // fillGenericSpeakerLabels floor gives them clean sequential labels
            // rather than persisting a hallucinated or raw name.
            for (const [key, rawValue] of Object.entries(mapping)) {
                // Same coercion the action-item assignee gets. A `{name:'Tom'}`
                // reply used to become the literal speaker label
                // "[object Object]" on every one of that speaker's segments —
                // and, because it is a stable string, it survived rename,
                // reprocess and the report.
                const value = coerceName(rawValue);
                if (!value) { delete mapping[key]; continue; }
                mapping[key] = value;
                if (looksGenericSpeakerName(value) || value === key) {
                    delete mapping[key];
                    continue;
                }
                // The rule, not the request. The prompt asks the model to
                // respect the voiceprint exclusions; this enforces it. A model
                // that ignores the NOT lines would otherwise merge a separate
                // participant into an enrolled colleague — which is exactly how
                // a two-person meeting once came out as one speaker. The id is
                // left unmapped so fillGenericSpeakerLabels floors it.
                if (isRuledOut(key, value)) {
                    log.warn(`[Transcriptions] Dropped "${value}" for ${key} — ruled out by voiceprint`);
                    delete mapping[key];
                }
            }
            if (parsed.salvaged) {
                log.warn(`[Transcriptions] speaker mapping reply was truncated — salvaged ${Object.keys(mapping).length} of ${rows.length} IDs`);
            }
            log.info(`[Transcriptions] Speaker names via ${modelId}:`, mapping);
            // AFTER the sanitiser, deliberately: a real person whose name trips
            // looksGenericSpeakerName (someone actually called "Gast") must not
            // be stripped. Acoustic evidence outranks a text heuristic — and
            // the model was never asked about these IDs anyway.
            return lockedNames ? { ...mapping, ...lockedNames } : mapping;
        }
    } catch (err) {
        log.error('[Transcriptions] Speaker identification failed:', err.message);
    }
    // A failed/unparseable LLM reply must not throw away what the voiceprints
    // already established.
    return lockedNames ? { ...lockedNames } : null;
}

module.exports = {
    looksGenericSpeakerName,
    extractIntroducedNames,
    identifySpeakerNames,
};
