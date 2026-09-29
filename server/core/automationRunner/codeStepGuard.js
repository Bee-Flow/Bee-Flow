/**
 * What a code step's source allows at run time, decided before the sandbox
 * starts (execOutbound.execCode):
 *
 *   - a BLOCK finding (automation/codeSafety) stops the run with the plain
 *     sentence the editor showed: code that reaches for sandbox internals,
 *     modules, or builds code from text never runs;
 *   - declared parameters (JSDoc on main) get their defaults, their types
 *     and their required check (codeSafety/paramValues.js);
 *   - the HOST MANIFEST: the hosts the code names literally plus the step's
 *     `allowedHosts`. ctx.http to a host outside it is refused. A step whose
 *     code decides the host at run time and lists no hosts (older steps; the
 *     editor asks for the list now) runs in audit mode: allowed, and logged.
 *
 * Warnings never stop a run here: they are the author's to accept in the
 * editor. The analysis is cached per code text, so a routine that loops a
 * code step over a thousand rows parses it once.
 */

'use strict';

const { analyzeCode, blockingFindings } = require('../../automation/codeSafety');
const { applyParamValues } = require('../../automation/codeSafety/paramValues');
const { cleanHostList, hostListed, normaliseHost } = require('../../automation/codeSafety/hosts');
const defaultLog = require('../../telemetry/log');

const CACHE_MAX = 200;
const cache = new Map();

function analysisFor(code) {
    const key = String(code || '');
    if (cache.has(key)) return cache.get(key);
    const analysis = analyzeCode(key);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, analysis);
    return analysis;
}

/**
 * @param {object} step            the code step (code, allowedHosts)
 * @param {object} resolvedInputs  values, never bindings
 * @param {{ log?: object }} [opts]
 * @returns {{ refusal: string|null, inputs: object, analysis: object,
 *             refuseHost: (host: string) => string|null, manifest: { hosts: string[], enforced: boolean } }}
 */
function prepareCodeRun(step, resolvedInputs, { log = defaultLog } = {}) {
    const analysis = analysisFor(step && step.code);
    const listed = cleanHostList(step && step.allowedHosts);
    const manifest = {
        hosts: [...new Set([...(analysis.capabilities?.hosts || []), ...listed])],
        // Enforced when every host is known: the code names them all, or the
        // author listed where a run-time URL may go.
        enforced: analysis.ok && (!analysis.capabilities.dynamicHosts || listed.length > 0),
    };
    const refuseHost = (host) => {
        const h = normaliseHost(host);
        if (!h || hostListed(h, manifest.hosts)) return null;
        if (!manifest.enforced) {
            log.info(`[codeStep] audit: step ${step && step.id} reached unlisted host ${h} (no host list yet)`);
            return null;
        }
        return `This step may only send data to ${manifest.hosts.join(', ') || 'the hosts in its code'}; ${h} is not on that list. Add it under "Where this step may send data".`;
    };
    const base = { analysis, manifest, refuseHost };

    if (!analysis.ok) {
        const e = analysis.syntaxError;
        return { ...base, inputs: resolvedInputs, refusal: `The code has a syntax error at line ${e.line}, column ${e.column}: ${e.message}` };
    }
    const blocks = blockingFindings(analysis);
    if (blocks.length) {
        return { ...base, inputs: resolvedInputs, refusal: `This code step was stopped: ${blocks[0].message} (line ${blocks[0].line})` };
    }
    const applied = applyParamValues(analysis.params, resolvedInputs);
    if (applied.error) return { ...base, inputs: applied.inputs, refusal: applied.error.message };
    return { ...base, inputs: applied.inputs, refusal: null };
}

module.exports = { prepareCodeRun };
