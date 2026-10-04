// @typecheck
'use strict';
/**
 * The one way a "Find repeating work" scan reads a connected app, in either
 * mode: the pattern sources' server-chosen reads and the ideas mode's model-
 * chosen ones.
 *
 * Every read:
 *   - stops when the scan is stopped (the client went away);
 *   - passes the Privacy Shield's tool block lists first ("Outside tools" /
 *     "Own server"): a read whose arguments carry a blocked category is
 *     refused, never made, and the refusal is filed as a guardrail event;
 *   - runs inside its own capture context, so the ledger row names where the
 *     read went and the dispatcher does not write a second one;
 *   - is written to the egress ledger with the caller's audit base, whose
 *     source is `pattern_scan`. The miner's ledger reader takes chat sources
 *     only, so the scan's own reads never count as the user's work next time.
 *
 * What happens to the result is the caller's business: the pattern sources
 * template it in-process and drop it, the ideas mode guards it on its way to
 * a model.
 */

const { depsWith } = require('./depsWith');

const LOADERS = {
    executeTool: () => require('../../core/tools/toolDispatcher').executeTool,
    captureCall: () => require('../../core/http/captureCall').captureCall,
    logEgress: () => require('../../core/automationRunner/safety').logEgress,
    toolLoopGate: () => require('../../core/privacy/toolPiiGate').toolLoopGate,
    logGuardrailEvent: () => (/** @type {any} */ row) => require('../../stores/guardrailEventStore').logGuardrailEvent(row),
};

/** @param {Record<string, any>|null|undefined} overrides */
const depsFor = (overrides) => depsWith(LOADERS, overrides);

/**
 * `ok` with the value, or not: with the error, or with the Shield's refusal.
 * @typedef {{ ok: boolean, value?: any, error?: any, refusal?: { uiResult: string, modelError: string } }} ReadResult
 */

/** The scan's signal and a caller's (a source's own time limit), as one. */
function bothSignals(a, b) {
    const list = [a, b].filter(Boolean);
    return list.length > 1 ? AbortSignal.any(list) : list[0];
}

/**
 * @param {{
 *   userId: string, orgId?: string|null, session?: any,
 *   policy: { shield?: any, [k: string]: any }, auditBase: Record<string, any>,
 *   signal?: AbortSignal, tag?: string,
 * }} ctx
 * @param {Partial<{ executeTool: Function, captureCall: Function, logEgress: Function, toolLoopGate: Function, logGuardrailEvent: Function }>|null} [overrides]
 * @returns {{
 *   read: (name: string, args: object, opts?: { signal?: AbortSignal }) => Promise<ReadResult>,
 *   gate: { refuse: (toolName: string, args: object) => Promise<any>, forModel: (content: any, toolName: string) => Promise<any> },
 * }}
 */
function makeScanReader(ctx, overrides = null) {
    const d = depsFor(overrides);
    const gate = d.toolLoopGate({
        shield: ctx.policy?.shield ?? null,
        tag: ctx.tag || 'SuggestionScan',
        audit: (/** @type {object} */ fields) => Promise.resolve(d.logGuardrailEvent({ ...ctx.auditBase, ...fields })),
    });

    /**
     * @param {string} name
     * @param {object} args
     * @param {{ signal?: AbortSignal }} [opts]
     * @returns {Promise<ReadResult>}
     */
    async function read(name, args, opts = {}) {
        const signal = bothSignals(ctx.signal, opts.signal);
        if (signal?.aborted) return { ok: false, error: Object.assign(new Error('scan stopped'), { code: 'aborted' }) };
        const refusal = await gate.refuse(name, args);
        if (refusal) return { ok: false, refusal };
        const t0 = Date.now();
        const call = await d.captureCall(() => d.executeTool(name, args, {
            userId: ctx.userId, session: ctx.session, orgId: ctx.orgId ?? null, signal,
        }));
        try {
            await d.logEgress(/** @type {any} */ ({
                toolName: name, toolArgs: args,
                ...(call.ok ? { result: call.value } : { error: call.error }),
                probe: call.probe, policy: ctx.policy, auditBase: ctx.auditBase, mode: 'live', durationMs: Date.now() - t0,
            }));
        } catch (_) { /* never fail a scan on audit logging */ }
        return call.ok ? { ok: true, value: call.value } : { ok: false, error: call.error };
    }

    return { read, gate };
}

/**
 * The reader as the `executeTool(name, args, { signal })` the pattern sources
 * take: a value, or a throw the source turns into a skipped step. The signal
 * is the source's own (its time limit), on top of the scan's.
 * @param {{ read: (name: string, args: object, opts?: { signal?: AbortSignal }) => Promise<ReadResult> }} reader
 */
function asToolExecutor(reader) {
    return async (/** @type {string} */ name, /** @type {object} */ args, /** @type {{ signal?: AbortSignal }} */ opts = {}) => {
        const r = await reader.read(name, args, { signal: opts?.signal });
        if (r.ok) return r.value;
        // Its own code, so the scan's details say "blocked by Privacy Shield", not "could not be read".
        if (r.refusal) throw Object.assign(new Error(`${name}: refused by the Privacy Shield`), { code: 'shield' });
        throw r.error || new Error(`${name}: read failed`);
    };
}

module.exports = { makeScanReader, asToolExecutor };
