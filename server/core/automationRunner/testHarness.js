// @typecheck
/**
 * The dry-run test harness: what a golden replay, a form-scenario dry run or
 * "restart with my answers" hands executeAutomation so the run can answer a
 * form page and decide an approval from saved answers and, on request, reuse
 * stored AI answers.
 *
 *   harness = {
 *     source:      { kind: 'golden'|'scenario'|'run', id },
 *     formAnswers: { pages: { [formPageStepId]: { [field]: value } } } | null,
 *     approvals:   { [approvalStepId]: { decision: 'approve'|'reject', answers: { [field]: value } } } | null,
 *     aiAnswers:   'live' | 'cache',     (default 'live')
 *   }
 *
 * A step the harness has nothing for is synthesised and named in the run's
 * warnings (scenario_missing, core/automationRunner/dryPause.mts).
 *
 * It is honoured ONLY in a dry run: executeAutomation sets ctx.testHarness to
 * this normalised, deeply frozen value when mode is 'dry_run' and to null in
 * every other mode, so a live run, a resume and a partial run can never be
 * steered by it. Unknown values fall back to the defaults.
 */

'use strict';

const { deepFreeze } = require('../../utils/deepFreeze');

const SOURCE_KINDS = new Set(['golden', 'scenario', 'run']);
const DECISIONS = new Set(['approve', 'reject']);
const AI_ANSWERS = new Set(['live', 'cache']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A JSON copy, so freezing it never freezes the caller's object. */
const copyOf = (v) => JSON.parse(JSON.stringify(v));

/**
 * The approval decisions of a harness: a known decision per step, answers a plain object.
 * @param {unknown} raw
 * @returns {Record<string, { decision: 'approve'|'reject', answers: Record<string, any> }>|null}
 */
function normalizeApprovals(raw) {
    if (!isPlainObject(raw)) return null;
    const out = Object.create(null);
    for (const stepId of Object.keys(raw)) {
        const entry = raw[stepId];
        if (!isPlainObject(entry) || !DECISIONS.has(entry.decision)) continue;
        out[stepId] = { decision: entry.decision, answers: isPlainObject(entry.answers) ? copyOf(entry.answers) : {} };
    }
    return out;
}

/**
 * @param {any} harness
 * @returns {Readonly<{ source: { kind: 'golden'|'scenario'|'run', id: string|null }, formAnswers: { pages: Record<string, Record<string, any>> }|null, approvals: Record<string, { decision: 'approve'|'reject', answers: Record<string, any> }>|null, aiAnswers: 'live'|'cache' }>|null}
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
            if (isPlainObject(pagesIn[stepId])) pages[stepId] = copyOf(pagesIn[stepId]);
        }
        formAnswers = { pages };
    }
    return deepFreeze({
        source: {
            kind: SOURCE_KINDS.has(src.kind) ? src.kind : 'scenario',
            id: typeof src.id === 'string' ? src.id : null,
        },
        formAnswers,
        approvals: normalizeApprovals(harness.approvals),
        aiAnswers: AI_ANSWERS.has(harness.aiAnswers) ? harness.aiAnswers : 'live',
    });
}

/**
 * The harness a run executes under: only a dry run has one.
 * @param {string} mode
 */
function harnessFor(mode, harness) {
    return mode === 'dry_run' ? normalizeHarness(harness) : null;
}

/** The saved answers for one form page, or null when the harness has none for it. */
function pageAnswersFor(ctx, stepId) {
    const pages = ctx?.testHarness?.formAnswers?.pages;
    return pages && Object.prototype.hasOwnProperty.call(pages, stepId) ? pages[stepId] : null;
}

/**
 * The saved decision for one approval step ({ decision, answers }), or null when
 * the harness has none for it.
 */
function approvalDecisionFor(ctx, stepId) {
    const approvals = ctx?.testHarness?.approvals;
    return approvals && Object.prototype.hasOwnProperty.call(approvals, stepId) ? approvals[stepId] : null;
}

module.exports = { normalizeHarness, harnessFor, pageAnswersFor, approvalDecisionFor };
