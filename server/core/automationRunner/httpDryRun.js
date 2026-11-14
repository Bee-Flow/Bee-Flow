// @typecheck strict
/**
 * What a DRY-RUN http_request write (or authenticated GET) hands on, and the
 * URL check it still performs (RM-7; the dry-run honesty rule is written in
 * ./execCode.js's header).
 *
 * The answer is never sent for, so it is synthesized, but not as an empty
 * string: it has the SHAPE of the last real answer this step gave in a recent
 * run of the automation (keys and types with sample values, never an older
 * run's data), or `{}` when it never answered for real. A parse_json behind
 * it then does not go red on a step that works live. The URL is checked as
 * live, unless it is built from data the dry run simulated.
 */
'use strict';

const { parseStepUrl } = require('./httpQuery');
const { canReadRunData } = require('../../auth/callerRunVisibility');
const { isTruncatedOutput } = require('../../stores/automationStore/payloadTruncation');
const { fallback } = require('../../utils/bestEffort');
const { refIsSynthetic, collectBindingPaths } = require('./shared');

// How many recent runs a dry run looks through for this step's last real answer.
const DRY_RUN_SHAPE_RUN_WINDOW = 10;
const SHAPE_MAX_DEPTH = 8;
const SHAPE_MAX_KEYS = 100;

/**
 * The run history this module reads (a getter, so the store loads on first use).
 * @typedef {{ getRunsForAutomation: (automationId: string, opts: { limit: number }) => Promise<RunRow[]>,
 *   getRunStepsForRuns: (runIds: string[]) => Promise<RunStepRow[]> }} RunHistory
 * @typedef {{ id: string, mode?: string, connectionsMode?: string|null, startedByUserId?: string|null }} RunRow
 * @typedef {{ runId: string, stepId: string, status: string, output?: unknown }} RunStepRow
 */
const DEFAULT_DEPS = {
    runStore: () => /** @type {RunHistory} */ (/** @type {unknown} */ (require('../../stores/automationStore'))),
};
let deps = DEFAULT_DEPS;

/** The shape every synthesized dry-run answer of an http_request step has. */
function dryRunHttpOutput(extra = {}) {
    return { status: 200, ok: true, headers: {}, body: '{}', data: {}, _dryRun: true, ...extra };
}

/**
 * A value's shape with sample values: the keys and the types stay, the data
 * does not (strings 'sample', numbers 0, booleans false, a list keeps one
 * item). A dry run hands this on, never an older run's real values.
 * @param {unknown} value
 * @returns {unknown}
 */
function sampleShape(value, depth = 0) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return 'sample';
    if (typeof value === 'number') return 0;
    if (typeof value === 'boolean') return false;
    if (typeof value !== 'object' || depth >= SHAPE_MAX_DEPTH) return null;
    if (Array.isArray(value)) return value.length ? [sampleShape(value[0], depth + 1)] : [];
    const record = /** @type {Record<string, unknown>} */ (value);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(record).slice(0, SHAPE_MAX_KEYS)) out[k] = sampleShape(record[k], depth + 1);
    return out;
}

/**
 * The newest real (non-dry) answer this step recorded in a recent run of this
 * automation that the person running the dry run may read, or null.
 * @param {{ id?: string }} step
 * @param {{ automationId?: string, userId?: string }} ctx
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function lastLiveHttpOutput(step, ctx) {
    if (!ctx || !ctx.automationId || !step || !step.id) return null;
    try {
        const store = deps.runStore();
        if (typeof store.getRunsForAutomation !== 'function' || typeof store.getRunStepsForRuns !== 'function') return null;
        const runs = (await store.getRunsForAutomation(ctx.automationId, { limit: DRY_RUN_SHAPE_RUN_WINDOW })) || [];
        const live = runs.filter((r) => r && r.id && r.mode !== 'dry_run' && canReadRunData(r, ctx.userId));
        if (!live.length) return null;
        const rows = (await store.getRunStepsForRuns(live.map((r) => r.id))) || [];
        for (const run of live) { // newest first
            const row = rows.find((x) => x.runId === run.id && x.stepId === step.id && x.status === 'success'
                && x.output && typeof x.output === 'object' && !isTruncatedOutput(x.output));
            if (row) return /** @type {Record<string, unknown>} */ (row.output);
        }
    } catch (err) {
        fallback('core/automationRunner/httpDryRun:lastLiveHttpOutput', err);
    }
    return null;
}

/**
 * The synthesized answer of a dry-run write or authenticated GET: the shape of
 * the last real answer (status, header names, `data` and a JSON body to
 * match), or `{}` when this step never answered for real.
 * @param {{ id?: string }} step
 * @param {{ automationId?: string, userId?: string }} ctx
 */
async function dryRunPlaceholder(step, ctx) {
    const last = await lastLiveHttpOutput(step, ctx);
    if (!last) return dryRunHttpOutput({ _dryRunShape: 'empty' });
    let parsed = last.data;
    if (parsed === undefined && typeof last.body === 'string') {
        try { parsed = JSON.parse(last.body); } catch { parsed = undefined; }
    }
    const data = parsed !== undefined && parsed !== null && typeof parsed === 'object' ? sampleShape(parsed) : {};
    return dryRunHttpOutput({
        status: typeof last.status === 'number' ? last.status : 200,
        headers: last.headers && typeof last.headers === 'object' ? /** @type {Record<string, unknown>} */ (sampleShape(last.headers)) : {},
        body: JSON.stringify(data),
        data,
        _dryRunShape: 'last_live_run',
    });
}

/**
 * The parsed URL, or a throw for one that is not a web address or not http(s).
 * @param {string} url
 */
function checkedUrl(url) {
    const parsedUrl = parseStepUrl(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`http_request: unsupported URL scheme "${parsedUrl.protocol}" — only http/https are allowed.`);
    }
    return parsedUrl;
}

/**
 * checkedUrl for a dry run that will not send: a URL built from simulated
 * data may be malformed only because the sample was, so that passes; any
 * other bad URL throws, as live.
 * @param {{ url?: string }} step
 * @param {Parameters<typeof refIsSynthetic>[2] | null | undefined} ctx
 * @param {Parameters<typeof refIsSynthetic>[1]} runState
 * @param {string} url
 */
function checkDryRunUrl(step, ctx, runState, url) {
    try {
        checkedUrl(url);
    } catch (err) {
        const reads = collectBindingPaths({ kind: 'template', value: String(step.url || '') });
        if (!reads.some((p) => refIsSynthetic(p, runState, ctx || {}))) throw err;
    }
}

/**
 * Test seam: replace the run history (a getter); no argument restores the real one.
 * @param {Partial<typeof DEFAULT_DEPS> | null} [over]
 */
function _setDepsForTests(over = null) {
    deps = { ...DEFAULT_DEPS, ...(over || {}) };
}

module.exports = { dryRunHttpOutput, sampleShape, lastLiveHttpOutput, dryRunPlaceholder, checkedUrl, checkDryRunUrl, _setDepsForTests };
