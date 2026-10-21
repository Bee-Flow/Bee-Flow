// @typecheck
/**
 * The dry-run test harness: what a golden replay or a form-scenario dry run
 * hands executeAutomation so the run can answer a form page from saved answers
 * and, on request, reuse stored AI answers.
 *
 *   harness = {
 *     source:      { kind: 'golden'|'scenario', id },
 *     formAnswers: { pages: { [formPageStepId]: { [field]: value } } } | null,
 *     aiAnswers:   'live' | 'cache',     (default 'live')
 *   }
 *
 * It is honoured ONLY in a dry run: executeAutomation sets ctx.testHarness to
 * this normalised, deeply frozen value when mode is 'dry_run' and to null in
 * every other mode, so a live run, a resume and a partial run can never be
 * steered by it. Unknown values fall back to the defaults.
 */

'use strict';

const { deepFreeze } = require('../../utils/deepFreeze');

const SOURCE_KINDS = new Set(['golden', 'scenario']);
const AI_ANSWERS = new Set(['live', 'cache']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {any} harness
 * @returns {Readonly<{ source: { kind: 'golden'|'scenario', id: string|null }, formAnswers: { pages: Record<string, Record<string, any>> }|null, aiAnswers: 'live'|'cache' }>|null}
 *   null when no harness was given
 */
function normalizeHarness(harness) {
    if (!isPlainObject(harness)) return null;
    const src = isPlainObject(harness.source) ? harness.source : {};
    const pagesIn = isPlainObject(harness.formAnswers?.pages) ? harness.formAnswers.pages : null;
    let formAnswers = null;
    if (pagesIn) {
        const pages = Object.create(null);
        for (const stepId of Object.keys(pagesIn)) {
            // A copy, so freezing it never freezes the caller's object.
            if (isPlainObject(pagesIn[stepId])) pages[stepId] = JSON.parse(JSON.stringify(pagesIn[stepId]));
        }
        formAnswers = { pages };
    }
    return deepFreeze({
        source: {
            kind: SOURCE_KINDS.has(src.kind) ? src.kind : 'scenario',
            id: typeof src.id === 'string' ? src.id : null,
        },
        formAnswers,
        aiAnswers: AI_ANSWERS.has(harness.aiAnswers) ? harness.aiAnswers : 'live',
    });
}

/** The harness a run executes under: only a dry run has one. */
function harnessFor(mode, harness) {
    return mode === 'dry_run' ? normalizeHarness(harness) : null;
}

/** The saved answers for one form page, or null when the harness has none for it. */
function pageAnswersFor(ctx, stepId) {
    const pages = ctx?.testHarness?.formAnswers?.pages;
    return pages && Object.prototype.hasOwnProperty.call(pages, stepId) ? pages[stepId] : null;
}

module.exports = { normalizeHarness, harnessFor, pageAnswersFor };
