/**
 * releaseNotesDrafter — turns a build's raw git material into customer-facing
 * release notes, using the org's configured model.
 *
 * ── Where the model runs ───────────────────────────────────────────────────
 *
 * Two places, deliberately:
 *
 *   - HERE, when /ingest is handed raw git material. The call goes through
 *     `resolveModelForTierName`, so it honours EU-mode and org tier overrides —
 *     the same arrangement as core/cmsTranslate.js. The GitHub runner needs no
 *     model credentials for this path.
 *   - In CI (scripts/draft-release-notes.mjs), when the workflow has an
 *     ANTHROPIC_API_KEY. That path exists because the GitHub Release body has to
 *     be written in the same run that cuts the tag — the server's draft is not
 *     reachable from the runner in time, and a Release cannot be re-bodied
 *     without editing it afterwards. It POSTs the finished draft to /ingest,
 *     which then skips this module entirely.
 *
 * The prompt, the schema and the coercion rules live in ./releaseNotesFormat so
 * both paths produce identical entries. Change them there, not here.
 *
 * ── What it is fed, and what it is deliberately NOT fed ────────────────────
 *
 * Commit subjects, PR merge titles and a diffSTAT. Not the diff itself: it is
 * large, it blows the context on any real range, and it is exactly the kind of
 * payload that carries a stray credential into a third-party model.
 */

const llmClient = require('./llm/llmClient');
const { resolveModelForTierName } = require('./llm/modelResolver');
const fmt = require('./releaseNotesFormat');
const log = require('../telemetry/log');

async function _resolveModel(modelTier = 'fast') {
    try {
        return await resolveModelForTierName(modelTier || 'fast', { fallback: 'mistral-small-latest' });
    } catch (_) {
        return 'mistral-small-latest';
    }
}

/**
 * Draft notes for one release range.
 *
 * @param {{ commitSubjects?, prTitles?, diffstat?, services?, version?, modelTier? }} material
 * @returns {Promise<{title: string, lead: string, items: Array}>}
 */
async function draftReleaseNotes(material = {}) {
    const commits = fmt.normaliseLines(material.commitSubjects);
    const prs = fmt.normaliseLines(material.prTitles);

    // Nothing to summarise — do not spend a model call to be told so.
    if (!commits.length && !prs.length) {
        return { title: '', lead: '', items: [] };
    }

    const modelId = await _resolveModel(material.modelTier);

    const res = await llmClient.chat(modelId, [
        { role: 'system', content: fmt.SYSTEM_PROMPT },
        { role: 'user', content: fmt.buildUserPayload(material) },
    ], { maxTokens: 2048, temperature: 0.3 });

    let parsed;
    try {
        parsed = JSON.parse(fmt.stripFence(res.content));
    } catch (e) {
        // A malformed reply must not poison the changelog with garbage, and it
        // must not fail the build that triggered it. Empty is the safe answer;
        // the next dev build recomputes the same range anyway.
        log.warn('[releaseNotesDrafter] unparseable model reply:', e.message);
        return { title: '', lead: '', items: [] };
    }

    return fmt.coerceDraft(parsed);
}

module.exports = {
    draftReleaseNotes,
    // Re-exported under their historical underscore names: these are the unit
    // seams the drafter's own tests drive, and they are now shared with CI.
    _coerceDraft: fmt.coerceDraft,
    _normaliseLines: fmt.normaliseLines,
    _stripFence: fmt.stripFence,
    SYSTEM_PROMPT: fmt.SYSTEM_PROMPT,
};
