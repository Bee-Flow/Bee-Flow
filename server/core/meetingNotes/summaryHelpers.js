// @typecheck
/**
 * Shared meeting-notes pipeline helpers.
 *
 * Extracted from `server/routes/transcriptions.js` so both the HTTP routes
 * and the background Nextcloud Talk auto-ingest can reuse the exact same
 * logic without duplicating it (or creating a circular require on the route
 * module). Holds:
 *   - model-tier resolution (EU-aware)
 *   - speaker-name identification (diarization → real names)
 *   - meeting summary / title / action-item generation
 *   - the WhisperX provider call
 *   - segment merge + transcript/speaker artifact builder
 */

const llmClient = require('../llm/llmClient');
const fs = require('fs');

// Pure transcript/diarization shaping lives in its own dep-free module so it
// stays unit-testable without loading the LLM stack. Re-exported below.
const {
    formatTime,
    toContextBias,
    buildTranscriptArtifacts,
    applySpeakerNames,
    applySpeakerSummaries,
    tagSpeakerProvenance,
    fillGenericSpeakerLabels,
    assignSpeakersByOverlap,
    buildPipelineNotices,
    artifactsUsable,
    ARTIFACTS_FAILED,
    extractTranscriptClocks,
    sanitizeTimestamp,
} = require('./transcriptArtifacts');
const { renderTranscript, buildSpeakerNamingExcerpt, GAP_MARKER } = require('./transcriptExcerpt');
const { extractSpeakerEvidence } = require('./speakerEvidence');
const { parseJsonArray, parseJsonObject } = require('./llmJson');
const { buildSummarySystemPrompt } = require('./summaryTemplates');
const log = require('../../telemetry/log');

// A transcript this long is a runaway recording, not a meeting. Bounds the
// request; the real limit is the model's context, which we are nowhere near
// (a 100-minute meeting is ~154k chars ≈ 44k tokens).
const ACTION_ITEM_MAX_CHARS = 500000;

// One budget for BOTH the original summary and regenerate-summary — the
// regenerate route used to run at 4096 and truncated long meetings harder
// than the first pass did.
const SUMMARY_MAX_TOKENS = 8192;

// Ceiling for every meeting-notes LLM call. Deliberately below the 10-minute
// gmeet job lease: a stalled provider call must fail (and release the job)
// before another pod can re-claim it.
const MEETING_LLM_TIMEOUT_MS = Number(process.env.MEETING_LLM_TIMEOUT_MS) || 540_000;

const LANG_NAMES = { nl: 'Dutch', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese' };

/**
 * Resolve the model for the summary / action-item steps.
 *
 * Asks for `thinking`, not `smart`. `smart` is a legacy alias that is never
 * written into `chat_model_tiers` (the config write path emits only
 * fast|standard|swarm|thinking|writer|pro), so modelResolver fell through its
 * `tiers[name] || tiers[fallbackTier]` chain to the FAST tier — meaning meeting
 * summaries and action items were silently produced by the fast model.
 * A hand-written `smart` key still wins, for anyone who set one deliberately.
 */
async function resolveSmartModel(userOrgId = null) {
    try {
        const { resolveModelForTierName, getEUAwareTiers } = require('../llm/modelResolver');
        // Must inspect the map rather than just ask for 'smart':
        // resolveModelForTierName hardcodes fallbackTier:'fast', so requesting a
        // tier that isn't configured returns the fast model — truthy, and
        // therefore silently wrong. That is the bug this function had.
        const tiers = await getEUAwareTiers({ userOrgId });
        // Both candidate tiers must be checked here: asking resolveModelForTierName
        // for a tier that isn't configured falls through its hardcoded
        // fallbackTier:'fast' — truthy, and therefore silently wrong again, one
        // tier over from the original bug.
        const tierName = tiers?.smart?.modelId ? 'smart' : (tiers?.thinking?.modelId ? 'thinking' : null);
        if (!tierName) return 'gemini-2.0-flash';
        return await resolveModelForTierName(tierName, { userOrgId, fallback: 'gemini-2.0-flash' });
    } catch (_) {
        return 'gemini-2.0-flash';
    }
}

async function resolveFastModel(userOrgId = null) {
    try {
        const { resolveModelForTierName } = require('../llm/modelResolver');
        return await resolveModelForTierName('fast', { userOrgId, fallback: 'gemini-2.0-flash-lite' });
    } catch (_) {
        return 'gemini-2.0-flash-lite';
    }
}

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

/**
 * Generate a structured meeting summary using the smart-tier LLM.
 *
 * When `opts.templatePrompt` is supplied (a user's/org's default summary
 * template), it drives the output using the same construction the Regenerate
 * route uses, so a saved default styles new meetings too. Without one, the
 * built-in localized prompt below runs — no behaviour change.
 */
async function generateMeetingSummary(transcript, language, userOrgId = null, opts = {}) {
    const { templatePrompt = null } = opts || {};
    try {
        const modelId = await resolveSmartModel(userOrgId);
        const langName = LANG_NAMES[language] || language;

        if (templatePrompt) {
            const result = await llmClient.chat(modelId, [
                { role: 'system', content: buildSummarySystemPrompt(templatePrompt, language) },
                { role: 'user', content: transcript },
            ], { maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.3, timeoutMs: MEETING_LLM_TIMEOUT_MS });
            const summary = (result.content || '').trim();
            log.info(`[Transcriptions] Meeting summary generated from default template (${summary.length} chars) via ${modelId}`);
            return summary;
        }

        // Native-language section headers for the most-used locales. For
        // unknown languages we fall back to English headers and let the LLM
        // translate the body into `langName`.
        const HEADERS = {
            nl: { summary: '📋 Samenvatting', topics: '🔑 Belangrijkste onderwerpen', decisions: '✅ Besluiten', actions: '📌 Actiepunten', insights: '💡 Inzichten' },
            en: { summary: '📋 Summary',      topics: '🔑 Key Topics',                decisions: '✅ Decisions Made', actions: '📌 Action Items', insights: '💡 Key Insights' },
            de: { summary: '📋 Zusammenfassung', topics: '🔑 Hauptthemen', decisions: '✅ Entscheidungen', actions: '📌 Aufgaben', insights: '💡 Erkenntnisse' },
            fr: { summary: '📋 Résumé',       topics: '🔑 Sujets clés',  decisions: '✅ Décisions',     actions: '📌 Actions',      insights: '💡 Points clés' },
        };
        const h = HEADERS[language] || HEADERS.en;

        const result = await llmClient.chat(modelId, [
            {
                role: 'system',
                content: `You are a meeting assistant. Create a concise, well-structured summary of the meeting transcript. Write the entire summary in ${langName} — do not mix languages.

Format with these markdown sections (use these EXACT section headings, in this order):
## ${h.summary}
A brief 2-3 sentence overview of what the meeting was about.

## ${h.topics}
- Bullet points of main topics discussed

## ${h.decisions}
- Decisions that were agreed upon (skip the section entirely if there are none)

## ${h.actions}
- Specific tasks assigned to people (skip if none)

## ${h.insights}
- Notable ideas, suggestions, or observations

Keep it concise and actionable. Skip empty sections rather than writing "none".`,
            },
            { role: 'user', content: transcript },
            // No JSON to fail here, so an over-long reply doesn't error — it just
            // persists a summary cut mid-sentence. A 100-minute meeting on a
            // reasoning tier (where thinking tokens eat the budget) is exactly
            // the case that hits it.
        ], { maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.3, timeoutMs: MEETING_LLM_TIMEOUT_MS });

        const summary = (result.content || '').trim();
        log.info(`[Transcriptions] Meeting summary generated (${summary.length} chars) via ${modelId}`);
        return summary;
    } catch (err) {
        log.error('[Transcriptions] Summary generation failed:', err.message);
        return '';
    }
}

/**
 * Generate a short, descriptive meeting title using the fast-tier LLM.
 */
async function generateMeetingTitle(summary, language, userOrgId = null) {
    try {
        const modelId = await resolveFastModel(userOrgId);
        const langName = LANG_NAMES[language] || language;

        const result = await llmClient.chat(modelId, [
            { role: 'system', content: `Generate a short, descriptive title (max 8 words) for this meeting based on the summary. Write in ${langName}. Return ONLY the title, nothing else. No quotes, no prefixes.` },
            { role: 'user', content: summary.substring(0, 1000) },
        ], { maxTokens: 50, temperature: 0, timeoutMs: MEETING_LLM_TIMEOUT_MS });

        const title = (result.content || '').trim().replace(/^["']|["']$/g, '');
        if (title && title.length > 2 && title.length < 100) {
            log.info(`[Transcriptions] AI title: "${title}"`);
            return title;
        }
    } catch (err) {
        log.error('[Transcriptions] Title generation failed:', err.message);
    }
    return null;
}

/**
 * A model-supplied due date → a valid "YYYY-MM-DD" string, or null.
 *
 * Same honesty rule as timestamps: an unreadable or wildly implausible date
 * disappears instead of masquerading as a deadline. Plausible = a real
 * calendar date within [meeting date − 1 month, meeting date + 2 years]
 * (deadlines discussed in a meeting are occasionally just past, never years
 * away).
 */
function sanitizeDueDate(raw, meetingDateIso = null) {
    const value = String(raw || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const due = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(due.getTime()) || due.toISOString().slice(0, 10) !== value) return null;
    const anchor = meetingDateIso ? new Date(`${meetingDateIso}T00:00:00Z`) : new Date();
    if (Number.isNaN(anchor.getTime())) return value;
    const DAY = 86_400_000;
    if (due.getTime() < anchor.getTime() - 31 * DAY) return null;
    if (due.getTime() > anchor.getTime() + 731 * DAY) return null;
    return value;
}

/** Model-supplied topic tags → ≤7 clean strings, never a person's name. */
/**
 * A person's name as a plain string, or '' when the model gave us something
 * that is not one. Never String()s an object — that yields "[object Object]",
 * which reads as a real value everywhere downstream.
 */
function coerceName(raw) {
    if (typeof raw === 'string') return raw.trim();
    if (typeof raw === 'number') return String(raw);
    if (Array.isArray(raw)) return raw.map(coerceName).filter(Boolean).join(', ');
    if (raw && typeof raw === 'object') {
        const v = raw.name ?? raw.assignee ?? raw.text ?? raw.value;
        return typeof v === 'string' ? v.trim() : '';
    }
    return '';
}

function sanitizeTags(raw, personNames = []) {
    const people = new Set();
    for (const name of personNames) {
        const full = String(name || '').trim().toLowerCase();
        if (!full) continue;
        people.add(full);
        const first = full.split(/\s+/)[0];
        if (first.length >= 2) people.add(first);
    }
    const seen = new Set();
    const tags = [];
    for (const t of Array.isArray(raw) ? raw : []) {
        // Strings only. The model sometimes answers [{name:'planning'}], and
        // String()-ing that yields "[object Object]" — which tagsIfEmpty would
        // then persist as a permanent, unremovable-looking tag.
        if (typeof t !== 'string') continue;
        const tag = t.trim().replace(/^#/, '');
        if (!tag || tag.length > 40) continue;
        const norm = tag.toLowerCase();
        if (seen.has(norm) || people.has(norm)) continue;
        seen.add(norm);
        tags.push(tag);
        if (tags.length >= 7) break;
    }
    return tags;
}

/**
 * One smart-tier pass → every structured artifact besides summary/chapters:
 * action items (with optional spoken due dates), decisions, questions (open
 * or answered) and topic tags. Extracting them together costs the same one
 * LLM call the old action-item step already made.
 *
 * All timestamps are validated against the transcript's own line stamps
 * (junk disappears instead of seeking to 0:00; hour-truncated stamps are
 * repaired); due dates and tags go through the sanitizers above.
 *
 * @param {string} transcript
 * @param {string} language
 * @param {string|null} userOrgId
 * @param {{meetingDateIso?: string|null, personNames?: string[]}} [opts]
 *   meetingDateIso anchors relative deadlines ("by Friday"); personNames
 *   (speakers + attendees) keeps names out of the auto-tags.
 * @returns {Promise<{actionItems: Array, decisions: Array, questions: Array, tags: string[], ok: true}|typeof ARTIFACTS_FAILED>}
 *   Drie uitkomsten, twee vormen: een GESLAAGDE pass (met of zonder
 *   resultaat) heeft de vier lijsten, een MISLUKTE pass is ARTIFACTS_FAILED
 *   en heeft er geen. Zie transcriptArtifacts.js voor waarom het onderscheid
 *   in de waarde zit en niet in een losse vlag ernaast; `artifactsUsable` is
 *   de vraag die elke schrijver stelt.
 */
async function extractMeetingArtifacts(transcript, language, userOrgId = null, { meetingDateIso = null, personNames = [] } = {}) {
    try {
        const modelId = await resolveSmartModel(userOrgId);
        const langName = LANG_NAMES[language] || language;
        const unassigned = language === 'nl' ? 'Niet toegewezen' : 'Unassigned';

        const nlExample = language === 'nl' ? `

Voorbeelden van Nederlandse actiepunten:
- "Tom belt klant volgende week maandag" → text: "Klant bellen", assignee: "Tom", timestamp: "12:30"
- "Sandra stuurt het rapport voor vrijdag op" → text: "Rapport opsturen", assignee: "Sandra", timestamp: "08:15"` : '';

        const result = await llmClient.chat(modelId, [
            {
                role: 'system',
                content: `You are a meeting analyst. Extract the structured artifacts from the meeting transcript.

Return ONLY a JSON object with exactly these keys:
- "actionItems": array of {"text", "assignee", "timestamp", "due"} — every action item, task or follow-up. "text": what must be done (in ${langName}). "assignee": the responsible person's first name, or "${unassigned}" if unclear. "due": ONLY when a concrete deadline was spoken, as "YYYY-MM-DD"${meetingDateIso ? ` — resolve relative deadlines like "next Friday" against the meeting date ${meetingDateIso}` : ''}; omit the key when no deadline was mentioned.
- "decisions": array of {"text", "timestamp"} — decisions that were actually made (agreed, approved, concluded), each stated factually in ${langName}. Not proposals or open discussion points.
- "questions": array of {"text", "timestamp", "open"} — the important questions raised, in ${langName}. "open": true when the question was NOT answered during the meeting, false when it was.
- "tags": array of 3-7 short topic keywords (in ${langName}) for what the meeting was about. Lowercase, no person names, no generic words like "meeting".

Every "timestamp": copy it EXACTLY as it appears at the start of the line where it was discussed. Lines past the first hour look like "01:05:30" — keep the hour, never shorten it to "05:30".

Use an empty array for a list with no entries. Return ONLY valid JSON, no other text.${nlExample}`,
            },
            {
                role: 'user',
                // Send the whole meeting. This used to cut at 80k chars ≈ 52
                // minutes, so a 100-minute meeting yielded no action items at all
                // from its second half — where the decisions usually land.
                // generateMeetingSummary already sends the full transcript to
                // this same tier and works, so the length is not the constraint.
                content: transcript.length > ACTION_ITEM_MAX_CHARS
                    ? transcript.substring(0, ACTION_ITEM_MAX_CHARS)
                    : transcript,
            },
        ], { maxTokens: SUMMARY_MAX_TOKENS, temperature: 0, timeoutMs: MEETING_LLM_TIMEOUT_MS });

        const parsed = parseJsonObject((result.content || '').trim());
        if (!parsed) {
            log.warn('[Transcriptions] artifact reply could not be parsed — reporting a failed pass, not an empty meeting');
            return ARTIFACTS_FAILED;
        }
        // ── EEN AFGEKAPT ANTWOORD IS EEN VIERDE UITKOMST, EN GEEN GELUKTE ──
        // `parseJsonObject` redt van een afgekapt antwoord de sleutels die nog
        // compleet waren en sluit de rest zelf af (llmJson.js — "recovering
        // N-1 of N items is enormously better than recovering none"). Voor een
        // LIJST klopt dat; voor dit OBJECT niet, want de sleutels die het
        // plafond niet meer haalden zijn dan simpelweg weg — en `asArray`
        // hieronder maakt van elke ontbrekende sleutel een LEGE lijst.
        //
        // Zo'n antwoord kwam er dus uit als "gelukt, en in deze vergadering
        // zijn geen besluiten genomen", en de merge wiste er alle opgeslagen
        // AI-besluiten en -vragen mee. Precies bij de lange vergadering waar
        // het plafond geraakt wordt — de vergadering met de meeste besluiten.
        //
        // Het onderscheid dat dit bestand bewaakt is "leeg" versus "niet
        // gelezen", en bij een afgekapt antwoord is per sleutel niet te zeggen
        // welke van de twee het is. ONBEKEND VERSMALT: geen lijsten, dus geen
        // enkele schrijver vervangt er iets mee, en de notitieregel
        // (buildPipelineNotices) vertelt de gebruiker dat de pass niet is
        // afgerond. Wat je verliest is een halve extractie op een verse
        // notitie; wat je wint is dat een druk op "Opnieuw" nooit meer een
        // volledige besluitenlijst opruimt omdat het model één token te ver
        // moest schrijven.
        if (parsed.salvaged) {
            log.warn('[Transcriptions] artifact reply was truncated — reporting a failed pass, not an empty meeting (a missing key is unread, not empty)');
            return ARTIFACTS_FAILED;
        }
        const doc = parsed.value || {};
        const asArray = (v) => (Array.isArray(v) ? v : []);
        const clocks = extractTranscriptClocks(transcript);

        const actionItems = asArray(doc.actionItems)
            .map((item, idx) => {
                const out = {
                    id: `ai-${idx}`,
                    // Says out loud what the `ai-<n>` id only implies (M3).
                    // core/meetingNotes/actionItems.js deletes exactly these on
                    // a regenerate and keeps everything a person added, so the
                    // producer marking its own output is the cheapest half of
                    // that rule.
                    source: 'ai',
                    text: String(item?.text || '').trim(),
                    // Dezelfde tekst nog een keer, als IJKPUNT (M4). Zodra
                    // iemand `text` overtypt wijkt hij hiervan af, en dat is
                    // het enige bewijs waaraan de merge een correctie van een
                    // mens kan onderscheiden van "het model zei het deze keer
                    // anders". Hij hoort hier en niet pas in de merge, want de
                    // EERSTE pass (upload / auto-import) schrijft deze lijst
                    // rechtstreeks weg — een correctie op een verse notitie
                    // zou anders onbeschermd zijn tot de eerste regeneratie.
                    aiText: String(item?.text || '').trim(),
                    // Coerced, not passed through. The model occasionally answers
                    // `assignee: {name: 'Tom'}` or `['Tom','Sanne']`; that object
                    // was stored verbatim and every consumer that renders or
                    // compares it (the action-items list, the assignee filter,
                    // the report) then got an object where it expected a string.
                    assignee: coerceName(item?.assignee) || unassigned,
                    timestamp: sanitizeTimestamp(item?.timestamp, clocks),
                    done: false,
                };
                const due = sanitizeDueDate(item?.due, meetingDateIso);
                if (due) out.due = due;
                return out;
            })
            .filter((i) => i.text);

        const decisions = asArray(doc.decisions)
            .map((d, idx) => ({
                id: `d-${idx}`,
                text: String(d?.text || '').trim(),
                timestamp: sanitizeTimestamp(d?.timestamp, clocks),
            }))
            .filter((d) => d.text);

        const questions = asArray(doc.questions)
            .map((q, idx) => ({
                id: `q-${idx}`,
                text: String(q?.text || '').trim(),
                timestamp: sanitizeTimestamp(q?.timestamp, clocks),
                open: q?.open !== false,
            }))
            .filter((q) => q.text);

        return { actionItems, decisions, questions, tags: sanitizeTags(doc.tags, personNames), ok: true };
    } catch (err) {
        log.error('[Transcriptions] Artifact extraction failed:', err.message);
        return ARTIFACTS_FAILED;
    }
}

/**
 * Back-compat wrapper: action items only. New code should call
 * extractMeetingArtifacts and persist all artifacts from the one pass.
 *
 * LET OP: deze vorm kan de drie uitkomsten niet uit elkaar houden — een lege
 * lijst betekent hier zowel "niets afgesproken" als "de pass viel om". Precies
 * daarom mag nieuwe code hem niet gebruiken: wie hierop overschrijft, wist een
 * bewaarde lijst zodra de smart-tier een keer omvalt.
 */
async function extractActionItems(transcript, language, userOrgId = null) {
    const artifacts = await extractMeetingArtifacts(transcript, language, userOrgId);
    return artifactsUsable(artifacts) ? /** @type {{actionItems: Array}} */ (artifacts).actionItems : [];
}

/**
 * Segment the meeting into named chapters using the smart-tier LLM.
 *
 * Powers the chapter strip on the player timeline: a 100-minute recording
 * becomes navigable by topic instead of by scrubbing. Returns
 * `[{title, start}]` with `start` copied verbatim from the transcript's line
 * stamps — the client validates and drops anything unreadable rather than
 * trusting this output (same principle as the timeline markers: a bad
 * timestamp must disappear, not masquerade as a moment at 0:00).
 */
async function generateChapters(transcript, language, userOrgId = null) {
    try {
        const modelId = await resolveSmartModel(userOrgId);
        const langName = LANG_NAMES[language] || language;

        const result = await llmClient.chat(modelId, [
            {
                role: 'system',
                content: `You are a meeting analyst. Divide the transcript into 4-10 chapters — the natural topic sections of the meeting.

Return ONLY a JSON array of objects. Each object must have:
- "title": a short chapter name, 2-4 words, in ${langName}
- "start": the timestamp where the topic begins, copied EXACTLY as a STRING as it appears at the start of that line — e.g. "12:30" or "01:05:30". NEVER a number of seconds like 750, and past the first hour keep the hour ("01:05:30"), never shorten it to "05:30".
- "summary": one concise sentence (in ${langName}) describing what is discussed in this chapter — shown when the user hovers the chapter on the timeline.

Chapters must be in chronological order and cover the whole meeting; the first starts at the first spoken line. Do not invent timestamps. Return ONLY valid JSON, no other text.`,
            },
            {
                role: 'user',
                // Full transcript, same reasoning as action items: the summary
                // step already proves this tier handles the whole meeting.
                content: transcript.length > ACTION_ITEM_MAX_CHARS
                    ? transcript.substring(0, ACTION_ITEM_MAX_CHARS)
                    : transcript,
            },
            // Roomier ceiling than before (was 1024): each chapter now carries a
            // one-sentence summary too, and a truncated JSON array loses chapters.
        ], { maxTokens: 2048, temperature: 0, timeoutMs: MEETING_LLM_TIMEOUT_MS });

        const parsed = parseJsonArray((result.content || '').trim());
        if (parsed) {
            if (parsed.salvaged) {
                log.warn(`[Transcriptions] chapter reply was truncated — salvaged ${parsed.value.length} chapters`);
            }
            // Same validation boundary as action items: bad stamps are dropped
            // server-side too, hour-truncated ones repaired (the client's
            // normalizeChapters remains the last line of defense). `summary` is
            // optional — carried through when present so the timeline can show a
            // title + summary hover tooltip; old notes without it degrade to title.
            const clocks = extractTranscriptClocks(transcript);
            let chapters = parsed.value
                .filter(c => c && typeof c === 'object')
                .map(c => {
                    const chapter = { title: String(c.title || '').trim(), start: sanitizeTimestamp(c.start, clocks) };
                    const summary = String(c.summary || '').trim();
                    if (summary) chapter.summary = summary;
                    return chapter;
                })
                .filter(c => c.title && c.start);

            // Safety net: the model returned titled chapters but their timestamps
            // were unusable (numeric seconds, approximations, wrong format), so
            // sanitizeTimestamp dropped them all and the whole strip would vanish.
            // Rather than lose the table of contents, keep the titled chapters (in
            // order, with their summaries) and space them evenly across the
            // meeting. Chronological order is what the prompt guarantees.
            if (chapters.length < 2) {
                const titled = parsed.value.filter(c => c && typeof c === 'object' && String(c.title || '').trim());
                if (titled.length >= 2 && clocks.lastEnd > 0) {
                    chapters = titled.map((c, i) => {
                        const chapter = { title: String(c.title).trim(), start: formatTime(Math.round((i / titled.length) * clocks.lastEnd)) };
                        const summary = String(c.summary || '').trim();
                        if (summary) chapter.summary = summary;
                        return chapter;
                    });
                    log.warn(`[Transcriptions] chapter timestamps unusable — distributed ${chapters.length} titled chapters evenly across ${formatTime(clocks.lastEnd)}`);
                }
            }
            log.info(`[Transcriptions] Chapters: ${chapters.map(c => `${c.start} ${c.title}`).join(' | ')}`);
            return chapters;
        }
    } catch (err) {
        log.error('[Transcriptions] Chapter generation failed:', err.message);
    }
    return [];
}

/** One speaker's summary past this is a retelling, not a summary. */
const SPEAKER_SUMMARY_MAX_CHARS = 800;

/**
 * A short prose summary of what each participant contributed.
 *
 * Shown under their row in the Insights panel, so it answers "what did this
 * person bring to the meeting" — the points they raised, positions they took,
 * questions they asked, what they took on. Deliberately NOT a chronological
 * log: a timestamped play-by-play is what the transcript is for, and it read
 * as a wall of noise next to the talk-time stats.
 *
 * Its own call rather than a key on extractMeetingArtifacts: a focused prompt
 * writes markedly better prose, and a failure here must not take the action
 * items down with it. Same shape as generateChapters.
 *
 * @param {string} transcript
 * @param {Array<string>} speakerIds  Display names exactly as stored on speakers[].
 * @param {string} language
 * @param {string|null} userOrgId
 * @returns {Promise<Record<string, string>>} speakerId → prose. `{}` on any failure.
 */
async function generateSpeakerSummaries(transcript, speakerIds, language, userOrgId = null) {
    const names = (Array.isArray(speakerIds) ? speakerIds : [])
        .map(id => String(id || '').trim())
        .filter(Boolean);
    if (!names.length || !transcript) return {};

    try {
        const modelId = await resolveSmartModel(userOrgId);
        const langName = LANG_NAMES[language] || language;

        const result = await llmClient.chat(modelId, [
            {
                role: 'system',
                content: `You are a meeting analyst. For each participant listed by the user, describe what THAT PERSON contributed to the meeting: the points they raised, the positions they took, the questions they asked, and anything they took on.

Write 2-4 sentences per participant, in ${langName}, as flowing prose.
- NO bullet points, NO timestamps, NO quotes — this is a summary, not a transcript log.
- Write about their substance, not their speaking behaviour.
- Invent nothing. If someone barely spoke, say so in a single sentence.

Return ONLY a JSON object mapping each participant name — copied EXACTLY as the user wrote it — to their summary string. Include every participant. Return ONLY valid JSON, no other text.`,
            },
            {
                role: 'user',
                content: `Participants: ${names.join(', ')}\n\n${transcript.length > ACTION_ITEM_MAX_CHARS
                    ? transcript.substring(0, ACTION_ITEM_MAX_CHARS)
                    : transcript}`,
            },
        ], { maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.3, timeoutMs: MEETING_LLM_TIMEOUT_MS });

        const parsed = parseJsonObject((result.content || '').trim());
        if (!parsed) return {};
        if (parsed.salvaged) {
            log.warn('[Transcriptions] speaker-summary reply was truncated — salvaged a partial object');
        }

        // Only the speakers we asked about: a name the model invented would
        // attach a summary to a person who is not in this meeting.
        const known = new Set(names);
        /** @type {Record<string, string>} */
        const summaries = {};
        for (const [name, value] of Object.entries(parsed.value || {})) {
            const id = String(name || '').trim();
            if (!known.has(id)) continue;
            const text = String(value || '').trim().slice(0, SPEAKER_SUMMARY_MAX_CHARS);
            if (text) summaries[id] = text;
        }
        log.info(`[Transcriptions] Speaker summaries: ${Object.keys(summaries).join(', ') || 'none'}`);
        return summaries;
    } catch (err) {
        log.error('[Transcriptions] Speaker summary generation failed:', err.message);
        return {};
    }
}

/**
 * Transcribe with the self-hosted WhisperX service. Returns a
 * Voxtral-compatible `{ text, segments:[{text,start,end,speakerId}] }` shape.
 */
async function transcribeWithWhisperX(filePath, fileName, language, contextTerms) {
    // Deployment wiring (compose/k8s) wins; otherwise honour the URL an admin
    // set in Admin → Integrations → Transcription, which is stored encrypted
    // and must therefore be read with getSecret, not getConfig.
    //
    // There is deliberately NO hosted default here. This used to fall back to
    // a hardcoded https://services.beeflow.nl/whisperx, which meant a
    // self-hoster who configured WhisperX in the admin UI but left
    // WHISPERX_URL empty had their meeting audio uploaded to our servers —
    // contradicting the "no data leaves your server" promise of this provider.
    // (It 404'd there anyway: that host's ingress only serves /api/search.)
    const configStore = require('../../stores/configStore');
    const whisperxUrl = process.env.WHISPERX_URL || await configStore.getSecret('whisperx_url');
    if (!whisperxUrl) {
        throw new Error(
            'WhisperX URL not configured. Set WHISPERX_URL, or add your self-hosted '
            + 'WhisperX URL under Admin → Integrations → Transcription.'
        );
    }

    const form = new FormData();
    form.append('file', await fs.openAsBlob(filePath), fileName);
    form.append('language', language);
    form.append('diarize', 'true');
    if (contextTerms) form.append('context_terms', contextTerms);

    log.info(`[Transcriptions] Sending to WhisperX at ${whisperxUrl}/transcribe ...`);

    const apiKey = process.env.SERVICES_API_KEY;
    const resp = await fetch(`${whisperxUrl}/transcribe`, {
        method: 'POST',
        body: form,
        headers: apiKey ? { 'X-API-Key': apiKey } : {},
        signal: AbortSignal.timeout(600000), // 10 minutes for long files
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`WhisperX service error (${resp.status}): ${errText}`);
    }

    const data = /** @type {{ segments?: Array<Record<string, any>>, text?: string, device?: string, processingTime?: number, [key: string]: any }} WhisperX /transcribe */ (await resp.json());
    log.info(`[Transcriptions] WhisperX: ${data.segments?.length || 0} segments, ${data.device}, processed in ${data.processingTime}s`);

    return {
        text: data.text || '',
        segments: (data.segments || []).map(seg => ({
            text: seg.text,
            start: seg.start,
            end: seg.end,
            speakerId: seg.speakerId || 'speaker_0',
        })),
    };
}

// Scaleway's audio endpoint only accepts these container formats; anything else
// (webm/opus, m4a/aac, mp4) is transcoded to mp3 first.
const SCALEWAY_AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.oga', '.mpga']);

function ffmpegLib() {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    const lib = require('fluent-ffmpeg');
    lib.setFfmpegPath(ffmpegInstaller.path);
    return lib;
}

/** Transcode `filePath` to a temp mp3 if its format isn't Scaleway-accepted. Returns {path, cleanup}. */
async function ensureScalewayFormat(filePath) {
    const path = require('path');
    const ext = path.extname(filePath).toLowerCase();
    if (SCALEWAY_AUDIO_EXTS.has(ext)) return { path: filePath, cleanup: null };

    const os = require('os');
    const crypto = require('crypto');
    // randomUUID, not a millisecond stamp: several uploads transcode
    // concurrently in one process and shared the same output path.
    const outPath = path.join(os.tmpdir(), `scaleway-stt-${crypto.randomUUID()}.mp3`);
    try {
        await new Promise((resolve, reject) => {
            ffmpegLib()(filePath)
                .audioChannels(1)
                .audioFrequency(16000)
                .format('mp3')
                .on('end', resolve)
                .on('error', reject)
                .save(outPath);
        });
    } catch (err) {
        // ffmpeg writes as it goes, so a failed transcode leaves a partial mp3
        // behind and the caller never gets a `cleanup` to call.
        try { fs.unlinkSync(outPath); } catch { /* never created */ }
        throw err;
    }
    return { path: outPath, cleanup: () => { try { fs.unlinkSync(outPath); } catch { /* ignore */ } } };
}

/**
 * Split audio into ~chunkSeconds mp3 chunks (16 kHz mono, Scaleway-safe), using
 * ffmpeg's segment muxer with a CSV segment list so each chunk's EXACT start
 * offset is read back (no cumulative drift from assuming fixed lengths).
 * Returns { chunks:[{path,start}], cleanup }.
 */
async function splitForScaleway(filePath, chunkSeconds) {
    const path = require('path');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scw-chunks-'));
    const listPath = path.join(dir, 'list.csv');
    // Everything below writes INTO `dir`, so any failure must remove the whole
    // directory — a long recording that fails mid-split otherwise leaves tens
    // of megabytes of chunks behind on every retry.
    try {
    await new Promise((resolve, reject) => {
        ffmpegLib()(filePath)
            .audioChannels(1)
            .audioFrequency(16000)
            .outputOptions([
                '-f', 'segment',
                '-segment_time', String(chunkSeconds),
                '-reset_timestamps', '1',
                '-segment_list', listPath,
                '-segment_list_type', 'csv',
            ])
            .on('end', resolve)
            .on('error', reject)
            .save(path.join(dir, 'chunk_%03d.mp3'));
    });
    // CSV rows: filename,start,end (seconds, relative to the source).
    const rows = fs.readFileSync(listPath, 'utf8').trim().split('\n').filter(Boolean);
    const chunks = rows.map(line => {
        const [fname, start] = line.split(',');
        return { path: path.join(dir, fname), start: parseFloat(start) || 0 };
    });
    return { chunks, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
    } catch (err) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        throw err;
    }
}

/** Run up to `limit` async tasks concurrently, preserving input order. */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) { const i = cursor++; out[i] = await fn(items[i], i); }
    }));
    return out;
}

/** One Scaleway transcription call for a single Scaleway-safe file. Returned
 *  segment timestamps are relative to THAT file. Retries with backoff on 429
 *  (Scaleway's audio-seconds-per-minute quota) and transient gateway errors,
 *  honouring Retry-After — this is what paces concurrent chunks under the quota. */
async function scalewayCallOnce(sendPath, cfg) {
    const path = require('path');
    const maxRetries = Number(process.env.SCALEWAY_MAX_RETRIES) || 8;
    for (let attempt = 0; ; attempt++) {
        const form = new FormData();
        form.append('file', await fs.openAsBlob(sendPath), path.basename(sendPath));
        form.append('model', cfg.model);
        if (cfg.language) form.append('language', cfg.language);
        form.append('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'segment');
        if (cfg.contextTerms) form.append('prompt', String(cfg.contextTerms)); // biases glossary spelling
        const resp = await fetch(`${cfg.baseUrl}/v1/audio/transcriptions`, {
            method: 'POST',
            body: form,
            headers: { Authorization: `Bearer ${cfg.apiKey}` },
            signal: AbortSignal.timeout(Number(process.env.SCALEWAY_TIMEOUT_MS) || 600000),
        });
        if (resp.ok) {
            const data = /** @type {{ segments?: Array<{ text?: string, start?: number, end?: number }>, text?: string }} */ (await resp.json());
            const segs = (data.segments || [])
                .map(s => ({ text: (s.text || '').trim(), start: s.start, end: s.end }))
                .filter(s => s.text);
            return { segments: segs, text: data.text || segs.map(s => s.text).join(' ') };
        }
        const retriable = resp.status === 429 || resp.status === 503 || resp.status === 504;
        if (retriable && attempt < maxRetries) {
            const retryAfter = Number(resp.headers.get('retry-after'));
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : Math.min(60000, 2000 * 2 ** attempt); // 2s,4s,8s… capped at 60s
            await new Promise(r => setTimeout(r, waitMs));
            continue;
        }
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`Scaleway transcription error (${resp.status}): ${errText}`);
    }
}

/**
 * Hybrid transcription: Scaleway cloud Whisper large-v3 for the transcript,
 * local pyannote (community-1) for speaker diarization, merged by time overlap.
 *
 * Scaleway (GDPR-EU, GPU, serverless) is fast but does not diarize; the local
 * WhisperX/diarization service does only diarization here (its `/diarize`
 * endpoint), so audio egress to the cloud buys speed while speaker labels come
 * from the on-prem model. Returns the same
 * `{ text, segments:[{text,start,end,speakerId}] }` shape as the other providers.
 *
 * Requires `scaleway_api_key`. Speaker labels require a diarizer URL
 * (`WHISPERX_URL` or the encrypted `whisperx_url` secret); without one the
 * transcript is returned with a single `speaker_0`.
 */
async function transcribeWithScaleway(filePath, fileName, language, contextTerms) {
    const configStore = require('../../stores/configStore');

    // Admin-UI key (encrypted) wins; env fallback for env-configured deployments.
    const apiKey = (await configStore.getSecret('scaleway_api_key')) || process.env.SCALEWAY_API_KEY;
    if (!apiKey) {
        throw new Error(
            'Scaleway API key not configured. Add it under '
            + 'Admin → Integrations → Transcription (Scaleway), or set SCALEWAY_API_KEY.'
        );
    }
    const baseUrl = (await configStore.getConfig('scaleway_url')) || process.env.SCALEWAY_URL || 'https://api.scaleway.ai';
    const model = (await configStore.getConfig('scaleway_model')) || 'whisper-large-v3';
    const cfg = { apiKey, baseUrl, model, language, contextTerms };

    // 1. Cloud transcription (verbose_json → per-segment timestamps). Scaleway's
    // endpoint times out on very long/large single requests (observed HTTP 504
    // "stream timeout" on a ~92 MB / 1h40 file), so split big inputs into chunks,
    // transcribe them in parallel, and stitch results back with each chunk's real
    // time offset. Thresholds are env-tunable.
    const fileSize = fs.statSync(filePath).size;
    const CHUNK_THRESHOLD = Number(process.env.SCALEWAY_CHUNK_THRESHOLD_BYTES) || 20 * 1024 * 1024;
    const CHUNK_SECONDS = Number(process.env.SCALEWAY_CHUNK_SECONDS) || 600;
    const CONCURRENCY = Number(process.env.SCALEWAY_CHUNK_CONCURRENCY) || 2;

    let rawSegments = [];
    let fullText = '';
    if (fileSize > CHUNK_THRESHOLD) {
        log.info(`[Transcriptions] Scaleway: ${(fileSize / 1e6).toFixed(0)} MB > threshold — splitting into ${CHUNK_SECONDS}s chunks`);
        const { chunks, cleanup } = await splitForScaleway(filePath, CHUNK_SECONDS);
        let failedChunks = 0;
        try {
            log.info(`[Transcriptions] Scaleway: ${chunks.length} chunks (up to ${CONCURRENCY} in parallel)`);
            // Partial-tolerant: a chunk that exhausts its retries (e.g. sustained
            // 429 quota) yields a flagged gap for its time range instead of
            // failing the whole job and throwing away every other chunk.
            const perChunk = await mapLimit(chunks, CONCURRENCY, async (ch, idx) => {
                try {
                    const r = await scalewayCallOnce(ch.path, cfg);
                    log.info(`[Transcriptions] Scaleway chunk ${idx + 1}/${chunks.length} @${ch.start.toFixed(0)}s: ${r.segments.length} segs`);
                    return r.segments.map(s => ({ text: s.text, start: (s.start || 0) + ch.start, end: (s.end || 0) + ch.start }));
                } catch (err) {
                    failedChunks++;
                    log.error(`[Transcriptions] Scaleway chunk ${idx + 1}/${chunks.length} @${ch.start.toFixed(0)}s FAILED — kept the other chunks: ${err.message}`);
                    // `gap: true` marks this as a hole, not speech. Without it a
                    // failed chunk contributed a full CHUNK_SECONDS (10 min) of
                    // "speaking time" to whichever speaker the overlap matcher
                    // assigned it to, and the same 10 minutes to the meeting
                    // duration — so one failed chunk could hand a participant a
                    // fabricated 40% airtime share in the Insights panel.
                    return [{ text: '[audio section could not be transcribed]', start: ch.start, end: ch.start + CHUNK_SECONDS, gap: true }];
                }
            });
            rawSegments = perChunk.flat().sort((a, b) => (a.start || 0) - (b.start || 0));
        } finally {
            cleanup();
        }
        // Only hard-fail if EVERY chunk failed (else the note would be all gaps).
        if (failedChunks >= chunks.length) {
            throw new Error(`Scaleway transcription failed for all ${chunks.length} chunks`);
        }
        if (failedChunks > 0) {
            log.warn(`[Transcriptions] Scaleway: ${failedChunks}/${chunks.length} chunks failed; note has gaps for those sections.`);
        }
        fullText = rawSegments.map(s => s.text).join(' ');
    } else {
        const { path: sendPath, cleanup } = await ensureScalewayFormat(filePath);
        try {
            log.info(`[Transcriptions] Sending to Scaleway ${model} at ${baseUrl}/v1/audio/transcriptions ...`);
            const r = await scalewayCallOnce(sendPath, cfg);
            rawSegments = r.segments;
            fullText = r.text;
        } finally {
            if (cleanup) cleanup();
        }
    }

    // Map to the shared segment shape. If Scaleway ever returns text-only (no
    // segments), degrade to one segment (no diarization possible without times).
    let segments = rawSegments.map(s => ({ text: s.text, start: s.start, end: s.end, speakerId: 'speaker_0' }));
    if (!segments.length && fullText) {
        segments = [{ text: fullText, start: 0, end: 0, speakerId: 'speaker_0' }];
    }
    log.info(`[Transcriptions] Scaleway: ${segments.length} segments total`);

    // 2. Local diarization + overlap merge (best-effort — transcript still
    // returns if the diarizer is down; speakers just collapse to speaker_0).
    const diarizerUrl = process.env.WHISPERX_URL || await configStore.getSecret('whisperx_url');
    const canDiarize = diarizerUrl && segments.length && segments.some(s => (s.end || 0) > 0);
    if (canDiarize) {
        try {
            const timeout = Number(process.env.WHISPERX_DIARIZE_TIMEOUT_MS) || 1800000; // 30 min: CPU diarization of long meetings
            const form = new FormData();
            form.append('file', await fs.openAsBlob(filePath), fileName); // original file; /diarize decodes any format
            const apiSvcKey = process.env.SERVICES_API_KEY;
            log.info(`[Transcriptions] Diarizing via ${diarizerUrl}/diarize ...`);
            const resp = await fetch(`${diarizerUrl}/diarize`, {
                method: 'POST',
                body: form,
                headers: apiSvcKey ? { 'X-API-Key': apiSvcKey } : {},
                signal: AbortSignal.timeout(timeout),
            });
            if (!resp.ok) throw new Error(`diarizer ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
            const dia = /** @type {{ speakers?: Array<{ start: number, end: number, speaker: string }> }} */ (await resp.json());
            const turns = dia.speakers || [];
            if (turns.length) {
                segments = assignSpeakersByOverlap(segments, turns);
                log.info(`[Transcriptions] Diarization merged: ${turns.length} turns → ${new Set(segments.map(s => s.speakerId)).size} speakers`);
            }
        } catch (err) {
            log.warn(`[Transcriptions] Scaleway hybrid diarization failed (transcript kept, no speakers): ${err.message}`);
        }
    } else if (!diarizerUrl) {
        log.warn('[Transcriptions] No diarizer configured (WHISPERX_URL / whisperx_url) — Scaleway transcript has no speaker labels.');
    }

    return { text: fullText, segments };
}


module.exports = {
    resolveSmartModel,
    resolveFastModel,
    identifySpeakerNames,
    generateMeetingSummary,
    generateMeetingTitle,
    extractActionItems,
    extractMeetingArtifacts,
    generateChapters,
    generateSpeakerSummaries,
    applySpeakerSummaries,
    tagSpeakerProvenance,
    transcribeWithWhisperX,
    transcribeWithScaleway,
    toContextBias,
    formatTime,
    buildTranscriptArtifacts,
    applySpeakerNames,
    fillGenericSpeakerLabels,
    buildPipelineNotices,
    artifactsUsable,
    ARTIFACTS_FAILED,
    SUMMARY_MAX_TOKENS,
};
