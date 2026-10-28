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
 * automation's view (analyze) or edit (test) role. Without it, the router's own
 * gates apply (signed in, the automations feature, an active org).
 */

'use strict';

const express = require('express');
const { z } = require('../../utils/zod');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');

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

/** The answer for a code run that was refused: the shapes /code/test has always had. */
function refuse(res, r) {
    if (r.code === 'code_syntax_error') return res.status(422).json({ error: r.message, code: r.code, syntaxError: r.details.syntaxError });
    if (r.code === 'code_blocked') return res.status(422).json({ error: r.message, code: r.code, findings: r.details.findings });
    if (r.code === 'code_param_invalid') return res.status(422).json({ error: r.message, code: r.code, param: r.details.param });
    throw new HttpError(r.status, r.code, r.message);
}

/**
 * @param {{ store?: object, access?: object, sandbox?: object, limiter?: Function, now?: () => number }} [overrides]
 */
function makeCodeToolsRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const { makeAutomationAccess } = require('../../automation/access');
    const access = overrides.access || makeAutomationAccess(overrides.store ? { store: overrides.store } : {});
    const sandbox = () => overrides.sandbox || require('../../automation/codeSandbox');
    const { analyzeCode } = require('../../automation/codeSafety');
    const { runCodeOnce } = require('../../automation/testing/codeTestRun');
    const now = overrides.now || (() => Date.now());
    const analyzeLimiter = overrides.limiter
        || require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 120 });
    const testLimiter = overrides.limiter
        || require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 20 });

    /**
     * The automation the call is about, when it names one; `false` after a 403/404 was sent.
     * @param {string} need
     */
    async function automationFor(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, need) {
        const id = req.body.automationId;
        if (!id) return null;
        const a = await store().getAutomation(id);
        if (!a) { res.status(404).json({ error: 'Not found' }); return false; }
        const acc = await access.guard(req, res, a, need);
        return acc ? a : false;
    }

    router.post('/code/analyze', analyzeLimiter, validate({ body: AnalyzeBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof AnalyzeBody>, import('qs').ParsedQs>} */ req, res) => {
        const a = await automationFor(req, res, 'view');
        if (a === false) return;
        const { code, allowedTools = [], allowedHosts = [] } = req.body;
        res.json(analyzeCode(code, { allowedTools, allowedHosts }));
    });

    router.post('/code/test', testLimiter, validate({ body: TestBody }), async (/** @type {import('express').Request<{}, any, import('zod').infer<typeof TestBody>, import('qs').ParsedQs>} */ req, res) => {
        const a = await automationFor(req, res, 'edit');
        if (a === false) return;
        const { code, inputs = {}, allowedTools = [], allowedHosts = [], limits = {} } = req.body;
        const orgId = (a && a.organizationId) || req.session?.user?.organizationId || req.session?.user?.id || null;
        const out = await runCodeOnce(
            { code, inputs, allowedTools, allowedHosts, limits, concurrencyKey: orgId },
            { getSandbox: sandbox, now },
        );
        if (out.refusal) return refuse(res, out.refusal);
        if (out.ok === false) return res.json({ error: out.error, logs: [], calls: [], durationMs: out.durationMs });
        return res.json({ result: out.result, logs: out.logs, calls: out.calls, durationMs: out.durationMs });
    });

    return router;
}

module.exports = { makeCodeToolsRouter, AnalyzeBody, TestBody };
