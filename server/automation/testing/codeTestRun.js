// @typecheck strict
/**
 * Run a piece of code once in the sandbox, in TEST mode.
 *
 * The one pipeline behind "Try it" in the code editor (POST /code/test) and
 * the test cases on a code step or custom node: analyse the code, refuse what
 * is blocked, fill in the declared parameters, run it in the sandbox's test
 * mode (every call to the outside is recorded and answered with a placeholder,
 * nothing leaves Bee Flow) and report what happened.
 *
 * Outcomes:
 *   {refusal: {status, code, message, details}}   the code never ran
 *       422 code_syntax_error | code_blocked | code_param_invalid, 503 code_sandbox_missing
 *   {ok: true, result, logs, calls, durationMs}   it ran
 *   {ok: false, error, logs: [], calls: [], durationMs}   it threw or hit a limit
 *       (an ordinary outcome of trying code, so data, not a server error)
 *
 * The sandbox is injected; user code is never evaluated here.
 */

'use strict';

const { analyzeCode, blockingFindings } = require('../codeSafety');
const { applyParamValues } = require('../codeSafety/paramValues');

/**
 * @param {{
 *   code: string,
 *   inputs?: Record<string, unknown>,
 *   allowedTools?: string[],
 *   allowedHosts?: string[],
 *   limits?: Record<string, number>,
 *   concurrencyKey?: string|null,
 * }} args
 * @param {{ sandbox?: any, getSandbox?: () => any, now?: () => number }} [deps]  `getSandbox` resolves the sandbox only once the code passed the checks
 */
async function runCodeOnce(args, deps = {}) {
    const { code, inputs = {}, allowedTools = [], allowedHosts = [], limits = {}, concurrencyKey = null } = args;
    const now = deps.now || (() => Date.now());
    const analysis = analyzeCode(code, { allowedTools, allowedHosts });
    if (!analysis.ok) {
        return { refusal: {
            status: 422, code: 'code_syntax_error', message: 'The code has a syntax error.',
            details: { syntaxError: analysis.syntaxError },
        } };
    }
    const blocks = blockingFindings(analysis);
    if (blocks.length) {
        return { refusal: { status: 422, code: 'code_blocked', message: blocks[0].message, details: { findings: blocks } } };
    }
    const applied = applyParamValues(analysis.params, inputs);
    if (applied.error) {
        return { refusal: { status: 422, code: 'code_param_invalid', message: applied.error.message, details: { param: applied.error } } };
    }
    const sb = deps.sandbox || (deps.getSandbox ? deps.getSandbox() : require('../codeSandbox'));
    if (!sb || !sb.isAvailable()) {
        return { refusal: {
            status: 503, code: 'code_sandbox_missing',
            message: 'This server was installed without the code sandbox.', details: {},
        } };
    }
    const started = now();
    try {
        const out = await sb.runCode({
            code,
            inputs: applied.inputs,
            limits,
            mode: 'test',
            bridges: { allowedTools: new Set(allowedTools) },
            concurrencyKey,
        });
        return {
            ok: true,
            result: out.result === undefined ? null : out.result,
            logs: out.logs || [],
            calls: out.calls || [],
            durationMs: now() - started,
        };
    } catch (e) {
        return { ok: false, error: (e && /** @type {Error} */ (e).message) || String(e), logs: [], calls: [], durationMs: now() - started };
    }
}

module.exports = { runCodeOnce };
