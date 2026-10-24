// @typecheck
/**
 * The meeting-notes LLM steps after transcription: model-tier resolution
 * (EU-aware), summary, title, structured artifacts (action items, decisions,
 * questions, tags), chapters and per-speaker summaries.
 *
 * Split out of `summaryHelpers.js`, which re-exports the public functions.
 * `speakerNaming.js` imports the model resolution and `coerceName` from here.
 */

const llmClient = require('../llm/llmClient');
const {
    formatTime,
    artifactsUsable,
    ARTIFACTS_FAILED,
    extractTranscriptClocks,
    sanitizeTimestamp,
} = require('./transcriptArtifacts');
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
 *   Three outcomes, two shapes: a SUCCESSFUL pass (with or without a result) has the four lists, a FAILED
 *   pass is ARTIFACTS_FAILED and has none. See transcriptArtifacts.js for why the distinction lies in the
 *   value and not in a separate flag beside it; `artifactsUsable` is the question that every writer asks.
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
        // ── A TRUNCATED ANSWER IS A FOURTH OUTCOME, AND NOT A SUCCESS ──────
        // `parseJsonObject` salvages from a truncated answer the keys that were still complete and closes the rest
        // itself (llmJson.js: "recovering N-1 of N items is enormously better than recovering none"). For a LIST
        // that holds; for this OBJECT it does not, because the keys that did not reach the ceiling are simply
        // gone, and `asArray` below turns every missing key into an EMPTY list.
        //
        // So such an answer came out as "succeeded, and no decisions were made in this meeting", and the merge
        // wiped all stored AI decisions and questions with it. Precisely in the long meeting where the ceiling is
        // reached: the meeting with the most decisions.
        //
        // The distinction this file guards is "empty" versus "not read", and with a truncated answer it is not
        // possible to say per key which of the two it is. UNKNOWN NARROWS: no lists, so no writer replaces anything
        // with them, and the note notice (buildPipelineNotices) tells the user that the pass was not completed. What
        // you lose is a half extraction on a fresh note; what you win is that a press on "Regenerate" never again
        // wipes a complete decision list because the model had to write one token too many.
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
                    // The same text once more, as a REFERENCE POINT (M4). As soon as someone overtypes `text`, it deviates from
                    // this, and that is the only evidence by which the merge can tell a correction by a person from
                    // "the model phrased it differently this time". It belongs here and not only in the merge, because
                    // the FIRST pass (upload / auto-import) writes this list away directly; a correction on a fresh note
                    // would otherwise be unprotected until the first regeneration.
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
 * NOTE: this form cannot tell the three outcomes apart: an empty list here means both "nothing was agreed"
 * and "the pass fell over". That is precisely why new code must not use it: whoever overwrites on the strength
 * of it wipes a stored list as soon as the smart tier falls over once.
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

module.exports = {
    ACTION_ITEM_MAX_CHARS,
    SUMMARY_MAX_TOKENS,
    MEETING_LLM_TIMEOUT_MS,
    LANG_NAMES,
    resolveSmartModel,
    resolveFastModel,
    generateMeetingSummary,
    generateMeetingTitle,
    sanitizeDueDate,
    coerceName,
    sanitizeTags,
    extractMeetingArtifacts,
    extractActionItems,
    generateChapters,
    SPEAKER_SUMMARY_MAX_CHARS,
    generateSpeakerSummaries,
};
