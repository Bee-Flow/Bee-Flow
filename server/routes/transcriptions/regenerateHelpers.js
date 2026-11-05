// @typecheck strict
/**
 * The decisions of a summary regenerate (POST /:id/regenerate-summary in
 * routes/transcriptions/noteActions.js): which template and stamp it uses,
 * which notices of the stored summary it keeps, the tags after its write, and
 * whether the transcript it read is still the note's.
 */

const { leadingNotices } = require('./noteText.mts');
// Built-in summary templates + the shared prompt builder live in
// core/meetingNotes/summaryTemplates.js; custom (saved) templates come from the store.
const summaryTemplateStore = require('../../stores/summaryTemplateStore');
const { builtinPrompt, canAccessTemplate, buildSummarySystemPrompt } = require('../../core/meetingNotes/summaryTemplates');
const { resolveSmartModel, SUMMARY_MAX_TOKENS } = require('../../core/meetingNotes/summaryHelpers');
const llmClient = require('../../core/llm/llmClient');
const { logSurfaceUsage } = require('../../core/llm/surfaceUsage');
const { HttpError } = require('../../core/http/errors');
const { MEETING_LLM_TIMEOUT_MS } = require('./shared');
const { stampForBuiltin, stampForTemplate, EMPTY_STAMP, BUILTIN_STAMP_PREFIX } = require('../../core/meetingNotes/summaryStamp');

/**
 * The notices at the top of a stored summary that describe the TRANSCRIPT
 * (an engine fallback, a transcription that stopped early, voice
 * recognition): a regenerate keeps those, because the transcript it reads is
 * still the one they describe. The artifacts-failed line is not among them:
 * a regenerate runs that pass again and reports its own outcome.
 * @param {unknown} storedSummary
 */
function transcriptNotices(storedSummary) {
    const { buildPipelineNotices } = require('../../core/meetingNotes/transcriptArtifacts');
    const artifactsLines = new Set(['nl', 'en'].flatMap((language) => buildPipelineNotices({ artifactsFailed: true, language })));
    return leadingNotices(storedSummary).notices.filter((line) => !artifactsLines.has(line));
}

/**
 * Which prompt drives the summary, in precedence order:
 *   templateId  — a saved custom template (visibility-checked)
 *   customPrompt — an ephemeral "try before saving" prompt (owner-only, already gated)
 *   template     — a built-in key (default 'general'; unknown keys fall back to general)
 *
 * ── WHICH STAMP THAT YIELDS (M4 step 3) ─────────────────────────
 * Every branch sets `stamp`, including the one-off prompt — which sets it
 * EMPTY. The summary is overwritten; leaving a stamp of the previous template
 * in place would paste a template name onto text that template never wrote.
 * An empty stamp is therefore not a "forgotten field" but the answer.
 * @param {{ template: string, templateId: string | null | undefined, customPrompt: string | null | undefined }} body
 * @param {{ userId: string, orgIds: string[], groupIds: string[] }} viewer
 * @returns {Promise<{ templatePrompt: string, stamp: object } | null>} null: the saved template is not there for this viewer
 */
async function chooseTemplate({ template, templateId, customPrompt }, viewer) {
    if (templateId) {
        const tpl = await summaryTemplateStore.getById(templateId);
        if (!tpl || !canAccessTemplate(tpl, viewer)) return null;
        // The version of THIS moment, not that of the moment when someone later
        // opens the note.
        return { templatePrompt: tpl.prompt, stamp: stampForTemplate(tpl) };
    }
    if (typeof customPrompt === 'string' && customPrompt.trim()) {
        return { templatePrompt: customPrompt.trim().slice(0, 20000), stamp: { ...EMPTY_STAMP } };
    }
    // The same fallback as builtinPrompt: an unknown key stamps 'general',
    // because that prompt wrote it.
    return { templatePrompt: builtinPrompt(template), stamp: stampForBuiltin(template) };
}

/**
 * The template of a regenerate. A body that names none (no template,
 * templateId or customPrompt) keeps the note's OWN template, read from its
 * stamp: 'builtin:<key>' is that built-in, any other id that saved template.
 * A saved template this viewer cannot open now falls back to 'general'
 * instead of a 404, because the caller never asked for it. A body that names
 * one gets exactly that (and a 404 when it is not there for this viewer).
 * @param {{ template?: string, templateId?: string | null, customPrompt?: string | null }} body
 * @param {{ summaryTemplateId?: string | null }} transcription
 * @param {{ userId: string, orgIds: string[], groupIds: string[] }} viewer
 */
async function chooseRegenerateTemplate(body, transcription, viewer) {
    const { template, templateId = null, customPrompt = null } = body;
    if (template || templateId || (typeof customPrompt === 'string' && customPrompt.trim())) {
        return chooseTemplate({ template: template || 'general', templateId, customPrompt }, viewer);
    }
    const own = typeof transcription.summaryTemplateId === 'string' ? transcription.summaryTemplateId : '';
    const general = { template: 'general', templateId: null, customPrompt: null };
    if (own.startsWith(BUILTIN_STAMP_PREFIX)) {
        return chooseTemplate({ ...general, template: own.slice(BUILTIN_STAMP_PREFIX.length) || 'general' }, viewer);
    }
    if (own) {
        const saved = await chooseTemplate({ ...general, templateId: own }, viewer);
        if (saved) return saved;
    }
    return chooseTemplate(general, viewer);
}

/**
 * The tags a note carries after a regenerate's write: tagsIfEmpty fills an
 * empty column with the AI's and leaves tags that were there. The store
 * returns the column when it can; otherwise the same rule, applied here.
 * The meeting.processed event carries these, not the snapshot's.
 * @param {{ tags?: unknown }} stored  what the UPDATE returned
 * @param {{ tags?: unknown }} snapshot  the note as the regenerate read it
 * @param {string[]} aiTags  the tags of a usable artifact pass, else []
 * @returns {string[]}
 */
function tagsAfterWrite(stored, snapshot, aiTags) {
    if (Array.isArray(stored.tags)) return stored.tags;
    if (Array.isArray(snapshot.tags) && snapshot.tags.length) return snapshot.tags;
    return aiTags;
}

/**
 * Whether the note still holds the transcript a regenerate read minutes ago.
 * A re-transcription that started in another tab (or on the phone) during
 * the LLM calls replaces it; writing then would put the OLD transcript's
 * summary, chapters and speaker rows over the new one.
 * @param {{ status?: string, transcript?: string } | null} current  the note as it is now
 * @param {{ transcript?: string }} snapshot  the note the regenerate read
 */
function transcriptUnchanged(current, snapshot) {
    return !!current && current.status !== 'processing' && (current.transcript || '') === (snapshot.transcript || '');
}

/**
 * The regenerate pass itself: one summary call under the chosen template, with
 * the same budget and cut-off as the first generation (4096 used to make
 * REgenerating a long meeting truncate harder than the first pass did, and
 * without a cut-off an OpenAI-compatible adapter waits with no deadline). It
 * writes the same ledger row the first pass writes (the owner, the
 * organisation, the tokens), so a regenerated note is not free spend. An empty
 * answer (a reply spent on reasoning, a safety stop) is a failed regenerate,
 * not an empty meeting: it throws, so nothing is written and the passes that
 * follow are not paid for.
 * @param {{ transcription: { transcript: string, language?: string | null }, templatePrompt: string | null, userId: string, userOrgId: string | null }} p
 * @returns {Promise<string>} the summary text
 */
async function regenerateSummaryText({ transcription, templatePrompt, userId, userOrgId }) {
    const modelId = await resolveSmartModel(userOrgId);
    const startedAt = Date.now();
    const result = await llmClient.chat(modelId, [
        { role: 'system', content: buildSummarySystemPrompt(templatePrompt, transcription.language) },
        { role: 'user', content: transcription.transcript },
    ], { maxTokens: SUMMARY_MAX_TOKENS, temperature: 0.3, timeoutMs: MEETING_LLM_TIMEOUT_MS });
    logSurfaceUsage({ source: 'meeting_summary', userId, orgId: userOrgId, model: modelId, usage: result?.usage, startedAt });
    const generated = (result?.content || '').trim();
    if (!generated) {
        throw new HttpError(502, 'summary_empty', 'The model returned no summary. Nothing was changed; try again.');
    }
    return generated;
}

module.exports = { transcriptNotices, chooseTemplate, chooseRegenerateTemplate, regenerateSummaryText, tagsAfterWrite, transcriptUnchanged };
