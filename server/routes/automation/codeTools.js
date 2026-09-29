/**
 * The code editor's two helpers, for code that is not saved yet:
 *
 *   POST /code/analyze  what the code declares and what the checks find
 *                       (automation/codeSafety): parameters, findings, the
 *                       capability summary. Pure; stores nothing.
 *   POST /code/test     "Try it": runs the code once in the sandbox in TEST
 *                       mode, so every call to the outside (ctx.http,
 *                       ctx.integrations, ctx.db) is recorded and answered
 *                       with a placeholder and nothing leaves Bee Flow. Code
 *                       with a BLOCK finding is refused before it runs.
 *
 * Both take an optional `automationId`: when given, the caller needs that
 * routine's view (analyze) or edit (test) role. Without it, the router's own
 * gates apply (signed in, the automations feature, an active org).
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');

const MAX_CODE = 200 * 1024;

const Names = z.array(z.string().max(200)).max(200).optional();
const AnalyzeBody = z.object({
    code: z.string().max(MAX_CODE),
    allowedTools: Names,
    allowedHosts: Names,
    automationId: z.string().max(100).optional(),
    stepId: z.string().max(200).optional(),
}).strict();
const TestBody = z.object({
    code: z.string().max(MAX_CODE),
    inputs: z.record(z.string(), z.unknown()).optional(),
    allowedTools: Names,
    allowedHosts: Names,
    limits: z.object({
        memoryMb: z.number().optional(), cpuMs: z.number().optional(),
        wallMs: z.number().optional(), httpBudget: z.number().optional(),
    }).strict().optional(),
    automationId: z.string().max(100).optional(),
    stepId: z.string().max(200).optional(),
}).strict();

/**
 * @param {{ store?: object, access?: object, sandbox?: object, limiter?: Function, now?: () => number }} [overrides]
 */
function makeCodeToolsRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const { makeAutomationAccess } = require('../../automation/access');
    const access = overrides.access || makeAutomationAccess(overrides.store ? { store: overrides.store } : {});
    const sandbox = () => overrides.sandbox || require('../../automation/codeSandbox');
    const { analyzeCode, blockingFindings } = require('../../automation/codeSafety');
    const { applyParamValues } = require('../../automation/codeSafety/paramValues');
    const now = overrides.now || (() => Date.now());
    const analyzeLimiter = overrides.limiter
        || require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 120 });
    const testLimiter = overrides.limiter
        || require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 20 });

    /** The routine the call is about, when it names one; `false` after a 403/404 was sent. */
    async function routineFor(req, res, need) {
        const id = req.body.automationId;
        if (!id) return null;
        const a = await store().getAutomation(id);
        if (!a) { res.status(404).json({ error: 'Not found' }); return false; }
        const acc = await access.guard(req, res, a, need);
        return acc ? a : false;
    }

    router.post('/code/analyze', analyzeLimiter, validate({ body: AnalyzeBody }), async (req, res) => {
        const a = await routineFor(req, res, 'view');
        if (a === false) return;
        const { code, allowedTools = [], allowedHosts = [] } = req.body;
        res.json(analyzeCode(code, { allowedTools, allowedHosts }));
    });

    router.post('/code/test', testLimiter, validate({ body: TestBody }), async (req, res) => {
        const a = await routineFor(req, res, 'edit');
        if (a === false) return;
        const { code, inputs = {}, allowedTools = [], allowedHosts = [], limits = {} } = req.body;
        const analysis = analyzeCode(code, { allowedTools, allowedHosts });
        if (!analysis.ok) {
            return res.status(422).json({ error: 'The code has a syntax error.', code: 'code_syntax_error', syntaxError: analysis.syntaxError });
        }
        const blocks = blockingFindings(analysis);
        if (blocks.length) {
            return res.status(422).json({ error: blocks[0].message, code: 'code_blocked', findings: blocks });
        }
        const applied = applyParamValues(analysis.params, inputs);
        if (applied.error) {
            return res.status(422).json({ error: applied.error.message, code: 'code_param_invalid', param: applied.error });
        }
        const sb = sandbox();
        if (!sb.isAvailable()) {
            return res.status(503).json({ error: 'This server was installed without the code sandbox.', code: 'code_sandbox_missing' });
        }
        const started = now();
        const orgId = (a && a.organizationId) || req.session?.user?.organizationId || req.session?.user?.id || null;
        try {
            const out = await sb.runCode({
                code,
                inputs: applied.inputs,
                limits,
                mode: 'test',
                bridges: { allowedTools: new Set(allowedTools) },
                concurrencyKey: orgId,
            });
            res.json({ result: out.result === undefined ? null : out.result, logs: out.logs || [], calls: out.calls || [], durationMs: now() - started });
        } catch (e) {
            // The author's code threw, or hit a limit: an ordinary outcome of
            // trying code, answered as data rather than as a server error.
            res.json({ error: (e && e.message) || String(e), logs: [], calls: [], durationMs: now() - started });
        }
    });

    return router;
}

module.exports = { makeCodeToolsRouter, AnalyzeBody, TestBody };
