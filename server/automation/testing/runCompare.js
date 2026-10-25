// @typecheck
'use strict';
/**
 * Compare two runs of ONE automation, step by step.
 *
 *   compareRuns({ runA, runB, legsA, legsB, viewerId, ignorePaths, stepId }, deps)
 *     → CompareResult  (the shape routes/automation/runCompare.js documents)
 *
 * `runA` / `runB` are the journeys' root runs and `legsA` / `legsB` the legs
 * the viewer may read (routes get both from runDataAccess.readableRun). A step
 * row of any other leg is kept as a name only: its data is never opened, and
 * the step reads as `not_comparable`.
 *
 * What is compared is the step OUTPUT (plus the error text), by a structural
 * diff (jsonDiff.js) that hands handles to the output-differ registry
 * (outputDiffers.js): a generated file is compared by its content, not by id.
 * A step's verdict:
 *
 *   only_a / only_b   the step ran on one side only
 *   status_changed    both ran, with a different status
 *   not_comparable    a side's data is hidden from this viewer, or its output
 *                     was cut and no full copy was kept
 *   same              no changes
 *   soft              there are changes, but they are expected: the step
 *                     calls a model ('ai'), or exactly one side was SIMULATED
 *                     by a dry run ('simulated')
 *   changed           anything else
 *
 * The run's verdict is `changed` when any step is changed, only_* or
 * status_changed; else `soft` when any step is soft; else `same`.
 * not_comparable steps are counted in the summary but decide nothing.
 *
 * Generated files are summarised (fileSummary.js) and paired by step and order.
 * A file is only ever looked up THROUGH the run ids of its own side, so no id
 * from another journey, automation or organisation resolves.
 *
 * Reads only. The summaries and changes carry values cut to 200 characters,
 * and nothing here goes over MCP.
 */

const log = require('../../telemetry/log');
const { envCap } = require('../mcpRunReadCaps');
const { canReadRunData } = require('../../core/automationModel/callerRunVisibility');
const { isTruncatedOutput, fullOutputRefOf } = require('../../core/automationModel/payloadTruncation');
const { AI_STEP_TYPES } = require('../automationGraph');
const outputDiffers = require('./outputDiffers');
const { diffJson } = require('./jsonDiff');
const { summarizeFile, readCapped } = require('./fileSummary');
const { fallback } = require('../../utils/bestEffort');

const caps = () => ({
    maxSteps: envCap('AUTOMATION_RUN_COMPARE_MAX_STEPS', 2000),
    maxChanges: envCap('AUTOMATION_RUN_COMPARE_MAX_CHANGES', 200),
    maxFiles: envCap('AUTOMATION_RUN_COMPARE_MAX_FILES', 50),
    fileMaxBytes: envCap('AUTOMATION_RUN_COMPARE_FILE_MAX_BYTES', 20 * 1024 * 1024),
});

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isSimulated = (out) => isObject(out) && (out._dryRun === true || out._dryRunSynthesised === true);
const stepKey = (r) => `${r.parentStepId || ''}/${r.stepId}#${r.branchIndex ?? ''}`;

/** The step ids that call a model, from the definition the run ran. Empty when unknown. */
async function aiStepIds(store, run) {
    const ids = new Set();
    try {
        const def = await store.getVersionDefinition?.(run.automationId, run.version);
        if (def) for (const s of require('../aiActDetect').detectAiUse(def).steps) if (s.stepId) ids.add(s.stepId);
    } catch (e) {
        log.debug(`[automation/runCompare] version definition unavailable, AI classification by step type only: ${/** @type {Error} */ (e).message}`);
    }
    return ids;
}

/**
 * One side of the comparison: its steps by key, its readable run ids, its header.
 * @param {string} viewerId
 */
async function loadSide(run, legs, viewerId, store, aiIds) {
    const readable = (legs?.length ? legs : [run]).filter(l => canReadRunData(l, viewerId));
    const runIds = readable.map(l => l.id);
    const rows = await store.getRunStepsForChain(run.id);
    const byKey = new Map();
    for (const row of rows || []) {
        const hidden = !runIds.includes(row.runId);
        const prev = byKey.get(stepKey(row));
        if (!prev || (row.attempts || 1) >= (prev.row.attempts || 1)) byKey.set(stepKey(row), { row, hidden });
    }
    const latest = (legs?.length ? legs : [run]).slice(-1)[0] || run;
    const header = {
        runId: run.id, status: latest.status, mode: run.mode ?? null, version: run.version ?? null,
        triggerKind: run.triggerKind ?? null, startedAt: run.startedAt ?? null,
    };
    return { run, runIds, byKey, header, aiIds, files: new Map() };
}

/** The step's real output: the row's own, or the kept full copy of a cut one. */
async function outputOf(entry, side, store) {
    if (!entry || entry.hidden) return { ok: false };
    const out = entry.row.output;
    if (!isTruncatedOutput(out)) return { ok: true, value: out };
    const ref = fullOutputRefOf(out);
    // A reference to a run outside this side's readable legs is never followed.
    if (!ref || !side.runIds.includes(ref.runId)) return { ok: false };
    const full = await Promise.resolve(store.getRunFullOutput(ref.runId, ref.stepId, ref.attempts)).catch((e) => fallback('automation/testing/runCompare:outputOf', e, null));
    return full == null ? { ok: false } : { ok: true, value: full };
}

const errorChange = (ea, eb) => {
    const x = ea.row.error || null;
    const y = eb.row.error || null;
    if (x === y) return null;
    const change = !x ? 'added' : !y ? 'removed' : 'changed';
    return {
        path: '$error', change,
        ...(x ? { before: outputDiffers.cutValue(x) } : {}),
        ...(y ? { after: outputDiffers.cutValue(y) } : {}),
    };
};

/** @returns {Promise<any>} the StepCompare for one key. */
async function compareStep(key, ea, eb, env) {
    const row = (ea || eb).row;
    const out = {
        key, stepId: row.stepId, stepType: row.stepType ?? null, parentStepId: row.parentStepId ?? null,
        branchIndex: row.branchIndex ?? null,
        a: { present: !!ea, status: ea ? ea.row.status : null },
        b: { present: !!eb, status: eb ? eb.row.status : null },
        verdict: 'same', softReason: /** @type {(string | null) | null} */ (null), kind: 'json', changes: /** @type {({ after?: string | undefined; before?: string | undefined; path: string; change: string; })[]} */ ([]), changesTruncated: false,
    };
    if (!ea || !eb) { out.verdict = ea ? 'only_a' : 'only_b'; return out; }
    const [oa, ob] = await Promise.all([outputOf(ea, env.sideA, env.store), outputOf(eb, env.sideB, env.store)]);
    const comparable = oa.ok && ob.ok;
    if (comparable) {
        const d = await diffJson(oa.value, ob.value, {
            ignorePaths: env.ignorePaths, maxChanges: env.caps.maxChanges, differs: env.differs, ctx: env.ctx,
        });
        out.changes = d.changes;
        out.changesTruncated = d.truncated;
        const ec = errorChange(ea, eb);
        if (ec && !d.truncated) out.changes.push(ec);
        const topA = env.differs.differFor(oa.value);
        if (topA && topA === env.differs.differFor(ob.value)) out.kind = topA.kind;
    }
    if (out.a.status !== out.b.status) { out.verdict = 'status_changed'; return out; }
    if (!comparable) { out.verdict = 'not_comparable'; return out; }
    if (!out.changes.length) return out;
    const isAi = AI_STEP_TYPES.includes(out.stepType)
        || env.sideA.aiIds.has(out.stepId) || env.sideB.aiIds.has(out.stepId)
        || env.sideA.aiIds.has(out.parentStepId) || env.sideB.aiIds.has(out.parentStepId);
    out.softReason = isSimulated(oa.value) !== isSimulated(ob.value) ? 'simulated' : isAi ? 'ai' : null;
    out.verdict = out.softReason ? 'soft' : 'changed';
    return out;
}

/**
 * The summary of one file of one side, read through the byte cap, remembered per compare.
 * @param {string} label
 * @param {number} fileMaxBytes
 */
function summaryLoader(side, label, storage, fileMaxBytes) {
    return (file) => {
        const memo = side.files;
        if (!memo.has(file.id)) {
            memo.set(file.id, summarizeFile({
                file,
                readBytes: async (max) => {
                    const streamed = await storage.streamFile(file.storageKey);
                    return readCapped(streamed.stream, max);
                },
            }, { fileMaxBytes }).catch((e) => {
                log.warn(`[automation/runCompare] file summary failed (${label}): ${e.message}`);
                return null;
            }));
        }
        return memo.get(file.id);
    };
}

const byCreated = (x, y) => String(x.createdAt).localeCompare(String(y.createdAt)) || String(x.id).localeCompare(String(y.id));

/** FileCompare entries per stepId: the two sides' files paired in creation order. */
async function compareFiles(sideA, sideB, env) {
    const list = async (side) => {
        const files = await Promise.resolve(env.store.listGeneratedFilesForRuns(side.runIds)).catch((e) => fallback('automation/testing/runCompare:list', e, []));
        const own = (files || []).filter(f => f.automationId === side.run.automationId).sort(byCreated);
        return env.caps.maxFiles > 0 ? own.slice(0, env.caps.maxFiles) : own;
    };
    const [fa, fb] = await Promise.all([list(sideA), list(sideB)]);
    const truncated = env.caps.maxFiles > 0 && (fa.length >= env.caps.maxFiles || fb.length >= env.caps.maxFiles);
    const group = (files) => files.reduce((m, f) => m.set(f.stepId ?? null, [...(m.get(f.stepId ?? null) || []), f]), new Map());
    const ga = group(fa);
    const gb = group(fb);
    const result = new Map();
    for (const stepId of new Set([...ga.keys(), ...gb.keys()])) {
        const as = ga.get(stepId) || [];
        const bs = gb.get(stepId) || [];
        const items = [];
        for (let i = 0; i < Math.max(as.length, bs.length); i++) {
            const [sa, sb] = await Promise.all([as[i] ? env.loadA(as[i]) : null, bs[i] ? env.loadB(bs[i]) : null]);
            const change = !sa && !sb ? null
                : sa && !sb ? 'removed'
                    : !sa && sb ? 'added'
                        : outputDiffers.compareSummaries(sa, sb).length ? 'changed' : 'same';
            if (change) items.push({ stepId, a: sa, b: sb, change });
        }
        result.set(stepId, items);
    }
    return { result, truncated };
}

function tally(steps) {
    const s = { same: 0, changed: 0, soft: 0, onlyA: 0, onlyB: 0, notComparable: 0 };
    for (const st of steps) {
        if (st.verdict === 'same') s.same++;
        else if (st.verdict === 'soft') s.soft++;
        else if (st.verdict === 'only_a') s.onlyA++;
        else if (st.verdict === 'only_b') s.onlyB++;
        else if (st.verdict === 'not_comparable') s.notComparable++;
        else s.changed++;
    }
    return s;
}

/**
 * @param {{ runA: any, runB: any, legsA?: any[], legsB?: any[], viewerId: string, ignorePaths?: string[], stepId?: string|null }} input
 * @param {{ store?: any, storage?: any, differs?: any, caps?: Partial<ReturnType<typeof caps>> }} [deps]
 */
async function compareRuns(input, deps = {}) {
    const { runA, runB, legsA, legsB, viewerId, ignorePaths = [], stepId = null } = input;
    const store = deps.store || require('../../stores/automationStore');
    const storage = deps.storage || require('../../stores/storageStore');
    const differs = deps.differs || outputDiffers;
    const cap = { ...caps(), ...(deps.caps || {}) };

    const [aiA, aiB] = await Promise.all([aiStepIds(store, runA), aiStepIds(store, runB)]);
    const [sideA, sideB] = await Promise.all([
        loadSide(runA, legsA, viewerId, store, aiA), loadSide(runB, legsB, viewerId, store, aiB),
    ]);
    const loadA = summaryLoader(sideA, 'a', storage, cap.fileMaxBytes);
    const loadB = summaryLoader(sideB, 'b', storage, cap.fileMaxBytes);
    // A handle resolves to a file of ITS OWN side's journey only.
    const loadFileSummary = async (fileId, which) => {
        const side = which === 'a' ? sideA : sideB;
        const file = await Promise.resolve(store.getGeneratedFileForRuns(fileId, side.runIds)).catch((e) => fallback('automation/testing/runCompare:loadFileSummary', e, null));
        if (!file || file.automationId !== side.run.automationId) return null;
        return (which === 'a' ? loadA : loadB)(file);
    };
    const env = { store, differs, sideA, sideB, caps: cap, ignorePaths, ctx: { caps: cap, loadFileSummary }, loadA, loadB };

    let keys = [...new Set([...sideA.byKey.keys(), ...sideB.byKey.keys()])];
    if (stepId) keys = keys.filter(k => (sideA.byKey.get(k) || sideB.byKey.get(k)).row.stepId === stepId);
    const truncatedSteps = cap.maxSteps > 0 && keys.length > cap.maxSteps;
    if (truncatedSteps) keys = keys.slice(0, cap.maxSteps);

    const steps = [];
    for (const key of keys) steps.push(await compareStep(key, sideA.byKey.get(key), sideB.byKey.get(key), env));

    const files = await compareFiles(sideA, sideB, env);
    for (const [fileStepId, items] of files.result) {
        const target = steps.find(s => s.stepId === fileStepId);
        if (target && items.length) target.files = items;
    }

    const summary = tally(steps);
    const verdict = summary.changed || summary.onlyA || summary.onlyB ? 'changed' : summary.soft ? 'soft' : 'same';
    return { a: sideA.header, b: sideB.header, verdict, summary, steps, truncated: truncatedSteps || files.truncated };
}

module.exports = { compareRuns, isSimulated };

/** @typedef {Record<string, any>} RunRow  an automation_runs row as the store maps it */

/** @typedef {Record<string, any>} StepRow  a run-step row as the store maps it */

/** @typedef {{ row: StepRow, hidden: boolean }} StepEntry */

/**
 * @typedef {Object} Side
 * @property {RunRow} run
 * @property {string[]} runIds
 * @property {Map<string, StepEntry>} byKey
 * @property {Record<string, unknown>} header
 * @property {Set<string>} aiIds
 * @property {Map<string, Promise<any>>} files
 */

/**
 * @typedef {Object} CompareEnv
 * @property {any} store
 * @property {any} differs
 * @property {Side} sideA
 * @property {Side} sideB
 * @property {ReturnType<typeof caps>} caps
 * @property {string[]} ignorePaths
 * @property {object} ctx
 * @property {(file: any) => Promise<any>} loadA
 * @property {(file: any) => Promise<any>} loadB
 */

/**
 * @typedef {Object} StepCompare
 * @property {string} key
 * @property {string} stepId
 * @property {string | null} stepType
 * @property {string | null} parentStepId
 * @property {number | null} branchIndex
 * @property {{ present: boolean, status: string | null }} a
 * @property {{ present: boolean, status: string | null }} b
 * @property {string} verdict
 * @property {string | null} softReason
 * @property {string} kind
 * @property {import('./outputDiffers').Change[]} changes
 * @property {boolean} changesTruncated
 * @property {any[]} [files]
 */
