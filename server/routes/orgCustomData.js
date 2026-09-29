/**
 * The "Your own data" test bench: /api/org-privacy-shield/:orgId/custom-data/*
 *
 * Four POST routes behind the Privacy Shield page, for org admins of an org
 * with the Enterprise feature `custom_data_types`:
 *
 *   /assist/preview  exactly what the assistant would see: the name, the
 *                    description and look-alikes of the examples. No model call.
 *   /assist          the same payload, checked again (409 preview_stale when it
 *                    no longer equals what the admin saw), scanned for personal
 *                    data, then one fast-tier forced-tool call. The answer comes
 *                    back as test sentences with the REAL examples swapped in
 *                    and gold marks computed here.
 *   /test            scores a draft type on test sentences with the matcher
 *                    production uses (words/pattern in Node, ai via the guard).
 *   /tune            measures candidate settings on the marked sentences and
 *                    returns the best one.
 *
 * Every route: requireAuth → a named per-user rate limit → the zod schema →
 * org admin of :orgId (403 not_org_admin) → the TARGET org has the feature
 * (403 feature_locked; the question the runtime asks before it enforces an
 * org's types, core/privacy/customData/licence.js, failing closed).
 * Errors are thrown as HttpError and answered by the terminal error handler as
 * `{ error, code, details?, correlationId }`.
 *
 * Privacy: real examples and sentences travel only between the admin's browser
 * and this server. The one outbound call (/assist) is built from an explicit
 * allow-list in core/privacy/customData/assist.js. Logs carry ids and counts,
 * never names, descriptions, examples or sentences.
 *
 * Mounted by routes/orgPrivacyShield.js with `router.use('/:orgId/custom-data', …)`;
 * this router uses mergeParams to read :orgId. Dependencies are injectable
 * (`createCustomDataRouter(deps)`) so the tests need no database, guard or model.
 */

'use strict';

const express = require('express');
const { z } = require('zod');

const { validate } = require('../core/http/validate');
const { HttpError } = require('../core/http/errors');
const log = require('../telemetry/log');
const assist = require('../core/privacy/customData/assist');
const bench = require('../core/privacy/customData/bench');
const tune = require('../core/privacy/customData/tune');
const { validatePattern } = require('../core/privacy/customData/patternTools');
const { TEST_ORIGINS } = require('../core/privacy/customData/testsStore');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const METHODS = ['words', 'pattern', 'ai'];
const TYPE_ID_RX = /^cdt_[0-9a-f]{10}$/;

// ── Dependencies ────────────────────────────────────────────────────────────

const DEFAULT_LOADERS = {
    // Tagged and deferred (auth/gateMeta.js lazyGate): the Access Map still
    // sees an auth gate, and loading this file does not load the user store.
    requireAuth: () => require('../auth/gateMeta').lazyGate(() => require('../auth/permissions').requireAuth, { axis: 'auth' }),
    isOrgAdmin: () => require('../auth/permissions').isOrgAdminForOrg,
    rateLimit: () => require('../utils/perUserRateLimit').perUserRateLimit,
    llm: () => require('../core/llm/llmClient'),
    resolveModel: () => require('../core/llm/modelResolver').resolveModelForTierName,
    detectPii: () => require('../core/privacy/piiDetection').detectPii,
    engine: () => require('../core/privacy/customTypes'),
    usage: () => require('../stores/usageStore'),
    licence: () => require('../core/privacy/customData/licence'),
    maskKey: () => require('../core/privacy/customData/mask').maskKeyFor,
    configStore: () => require('../stores/configStore'),
    log: () => log,
};

/** Each dependency is required on first use, so loading this file stays cheap. */
function makeDefaultDeps() {
    const memo = {};
    const deps = {};
    for (const [name, load] of Object.entries(DEFAULT_LOADERS)) {
        Object.defineProperty(deps, name, {
            enumerable: true,
            get() { if (!(name in memo)) memo[name] = load(); return memo[name]; },
        });
    }
    return deps;
}

// ── What a caller may send ──────────────────────────────────────────────────

const methodEnum = z.enum(METHODS, { errorMap: () => ({ message: 'The method is words, pattern or ai.' }) });
const typeId = z.string({ required_error: 'The type needs its id.' })
    .regex(TYPE_ID_RX, 'A type id is cdt_ followed by 10 hexadecimal characters.');

const TypeRef = z.object({
    id: typeId,
    name: z.string({ required_error: 'Give the type a name first.' })
        .trim().min(1, 'Give the type a name first.').max(60, 'A name holds at most 60 characters.'),
    description: z.string().max(400, 'A description holds at most 400 characters.').optional().default(''),
    method: methodEnum,
});

const Examples = z.array(
    z.string().trim().min(1, 'An example cannot be empty.').max(100, 'An example holds at most 100 characters.'),
).max(10, 'Use at most 10 examples.').default([]);

const KeepFixed = z.array(z.string().min(1).max(8, 'A fixed part holds at most 8 characters.'))
    .max(2, 'Keep at most 2 fixed parts.').optional();

const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the request as a JSON object.' }),
);

const PreviewBody = bodyOf({ type: TypeRef, examples: Examples, keepFixed: KeepFixed });
const AssistBody = bodyOf({
    type: TypeRef,
    examples: Examples,
    keepFixed: KeepFixed,
    expectLookalikes: z.array(z.string().max(100), {
        required_error: 'Look at the preview first: expectLookalikes is what it showed.',
    }).max(10),
});

const DraftType = z.object({
    id: typeId,
    name: z.string().max(60, 'A name holds at most 60 characters.').optional(),
    description: z.string().max(400, 'A description holds at most 400 characters.').optional(),
    method: methodEnum,
    tokenKey: z.string().max(40).optional(),
    words: z.object({
        values: z.array(z.string().max(120, 'A word holds at most 120 characters.')).max(500, 'A list holds at most 500 words.'),
        caseSensitive: z.boolean().optional(),
        wholeWord: z.boolean().optional(),
    }).optional(),
    pattern: z.object({
        source: z.string().max(500, 'This pattern is too long.'),
        caseSensitive: z.boolean().optional(),
        engine: z.enum(['re2', 'v8-legacy']).optional(),
    }).optional(),
    ai: z.object({
        prompt: z.string().max(60, 'A description for the AI holds at most 60 characters.'),
        floor: z.number().min(0.1, 'The floor lies between 0.10 and 0.95.').max(0.95, 'The floor lies between 0.10 and 0.95.'),
    }).optional(),
    origin: z.enum(['created', 'migrated']).optional(),
    legacy: z.boolean().optional(),
    createdAt: z.string().max(100).optional(),
    createdBy: z.string().max(200).optional(),
    updatedAt: z.string().max(100).optional(),
}).superRefine((t, ctx) => {
    if (!t[t.method]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [t.method], message: `A ${t.method} type needs its ${t.method} settings.` });
});

const Span = z.object({ start: z.number().int().min(0), end: z.number().int().min(1) });
const Sentence = z.object({
    id: z.string().min(1, 'A test sentence needs an id.').max(40, 'A sentence id holds at most 40 characters.'),
    text: z.string().min(1, 'A test sentence cannot be empty.').max(300, 'A test sentence holds at most 300 characters.'),
    gold: z.array(Span).max(5, 'Mark at most 5 parts per sentence.').nullish(),
    origin: z.enum(TEST_ORIGINS).optional(),
}).superRefine((s, ctx) => {
    if (!s.gold) return;
    let lastEnd = -1;
    for (const g of [...s.gold].sort((a, b) => a.start - b.start)) {
        if (g.start >= g.end || g.end > s.text.length) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gold'], message: 'A marked part lies outside its sentence.' });
            return;
        }
        if (g.start < lastEnd) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gold'], message: 'Marked parts cannot overlap.' });
            return;
        }
        lastEnd = g.end;
    }
});
const uniqueIds = (list, ctx) => {
    const seen = new Set();
    for (const s of list) {
        if (seen.has(s.id)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Two test sentences have the same id.' });
            return;
        }
        seen.add(s.id);
    }
};

const TestBody = bodyOf({
    type: DraftType,
    sentences: z.array(Sentence).min(1, 'Add a sentence to test.').max(40, 'Test at most 40 sentences at a time.').superRefine(uniqueIds),
});
const TuneBody = bodyOf({
    type: DraftType,
    sentences: z.array(Sentence).max(40, 'Tune on at most 40 sentences.').superRefine(uniqueIds).default([]),
    examples: Examples,
    candidates: z.object({
        aiLabels: z.array(z.string().max(60)).max(6).optional(),
        patterns: z.array(z.string().max(300)).max(3).optional(),
    }).optional(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const noStore = (res) => res.set('Cache-Control', 'private, no-store');
const listOf = (v) => (Array.isArray(v) ? v : []);
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
/** A sentence as the bench reads it: `gold: null` is the same as no gold. */
const benchSentences = (list) => listOf(list).map((s) => (s.gold ? s : { id: s.id, text: s.text, origin: s.origin }));

/** Org admin of the org in the URL, and that org has the feature. */
async function admit(req, d) {
    const orgId = String(req.params.orgId || '');
    const userId = req.session?.user?.id || null;
    if (!orgId || !(await d.isOrgAdmin(req, orgId))) {
        throw new HttpError(403, 'not_org_admin', 'Only organization admins can use the test bench.');
    }
    if (!(await d.licence.orgHasCustomDataTypes({ organizationId: orgId, userId }))) {
        throw new HttpError(403, 'feature_locked', 'Your own data types are part of the Enterprise plan.');
    }
    return { orgId, userId };
}

/**
 * The org's saved types: `customDataTypes` when present, otherwise the old
 * "Always hide these" terms as the engine migrates them.
 */
async function orgTypesOf(d, orgId) {
    const row = await d.configStore.getConfig(`org_privacy_shield_${orgId}`);
    if (!row || typeof row !== 'object') return [];
    if (Array.isArray(row.customDataTypes)) return row.customDataTypes.filter((t) => t && typeof t === 'object');
    if (Array.isArray(row.customSensitiveTerms) && row.customSensitiveTerms.length && typeof d.engine.migrateLegacyTerms === 'function') {
        return listOf(await d.engine.migrateLegacyTerms(orgId, row.customSensitiveTerms));
    }
    return [];
}

/** The org's "Never hide these" settings, applied to the assistant's personal-data check. */
async function allowConfigOf(d, orgId) {
    const row = await d.configStore.getConfig(`org_privacy_shield_${orgId}`);
    if (!row || typeof row !== 'object') return {};
    return { piiAllowTerms: row.piiAllowTerms, piiAllowPublicOrgs: row.piiAllowPublicOrgs };
}

/** One usage row per assistant call; chatForcedTool logs nothing itself. */
async function logAssistUsage(d, { userId, orgId, modelId, usage, startMs }) {
    try {
        await d.usage.logUsage({
            user_id: userId,
            agent_name: 'shield-custom-data-assist',
            agent_type: 'system',
            model: modelId,
            prompt_tokens: usage?.prompt_tokens || 0,
            completion_tokens: usage?.completion_tokens || 0,
            total_tokens: usage?.total_tokens || ((usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0)),
            cached_tokens: usage?.cached_tokens || 0,
            cache_creation_tokens: usage?.cache_creation_tokens || 0,
            source: 'shield_custom_data_assist',
            duration_ms: Date.now() - startMs,
            organization_id: orgId,
        });
    } catch (e) {
        d.log.warn('[CustomData] failed to log assistant usage:', e?.message || e);
    }
}

// ── The router ──────────────────────────────────────────────────────────────

function createCustomDataRouter(deps = null) {
    const d = deps || makeDefaultDeps();
    const router = express.Router({ mergeParams: true });
    const requireAuth = d.requireAuth;
    // Named: fleet-wide counts in Redis, so a documented limit is the real one.
    const previewLimiter = d.rateLimit({ name: 'shield-custom-data-preview', windowMs: MINUTE, max: 30 });
    const assistLimiter = d.rateLimit({ name: 'shield-custom-data-assist', windowMs: MINUTE, max: 6 });
    const assistDayLimiter = d.rateLimit({ name: 'shield-custom-data-assist-day', windowMs: DAY, max: 40 });
    const testLimiter = d.rateLimit({ name: 'shield-custom-data-test', windowMs: MINUTE, max: 30 });
    const tuneLimiter = d.rateLimit({ name: 'shield-custom-data-tune', windowMs: MINUTE, max: 10 });

    router.post('/assist/preview', requireAuth, previewLimiter, validate({ body: PreviewBody }), async (req, res) => {
        const { orgId } = await admit(req, d);
        noStore(res);
        const { type, examples, keepFixed } = req.body;
        const built = assist.buildOutbound({ type, examples, keepFixed, key: await d.maskKey(orgId), orgId });
        res.json({ outbound: built.outbound, keepFixedProposal: built.keepFixedProposal });
    });

    router.post('/assist', requireAuth, assistLimiter, assistDayLimiter, validate({ body: AssistBody }), async (req, res) => {
        const { orgId, userId } = await admit(req, d);
        noStore(res);
        const { type, examples, keepFixed, expectLookalikes } = req.body;
        const built = assist.buildOutbound({ type, examples, keepFixed, key: await d.maskKey(orgId), orgId });
        if (!sameList(built.outbound.lookalikes, expectLookalikes)) {
            throw new HttpError(409, 'preview_stale', 'The examples changed since the preview. Look at what the assistant will see again, then ask it.');
        }

        const findings = await assist.checkOutbound({
            outbound: built.outbound, detectPii: d.detectPii, engine: d.engine, orgTypes: await orgTypesOf(d, orgId),
            allowConfig: await allowConfigOf(d, orgId),
        });
        if (findings.length) {
            throw new HttpError(422, 'assist_personal_data',
                'The name or description contains personal data or values your organization hides. Remove them before asking the assistant.',
                { findings });
        }

        let modelId = null;
        try { modelId = await d.resolveModel('fast', { userOrgId: orgId, userId }); } catch (_) { modelId = null; }
        if (!modelId) {
            throw new HttpError(503, 'no_assist_model', 'No fast AI model is set up for this organization, so the assistant cannot run.');
        }

        const messages = assist.buildAssistMessages({
            name: built.outbound.name,
            description: built.outbound.description,
            lookalikes: built.outbound.lookalikes,
            method: type.method,
        });
        const startMs = Date.now();
        let result;
        try {
            result = await d.llm.chatForcedTool(modelId, messages, assist.ASSIST_TOOL, { ...assist.ASSIST_OPTIONS });
        } catch (err) {
            d.log.warn(`[CustomData] assistant call failed org=${orgId} status=${Number(err?.status) || '-'}`);
            throw new HttpError(502, 'assist_failed', 'The assistant did not answer. Try again in a moment.');
        }
        await logAssistUsage(d, { userId, orgId, modelId, usage: result?.usage, startMs });

        const clean = await assist.sanitizeAssistOutput(result?.structured, {
            pairs: built.pairs,
            examples,
            validatePattern: (source) => validatePattern(source, false, { engine: d.engine }),
            caseSensitive: false,
        });
        if (!assist.hasUsableOutput(clean)) {
            throw new HttpError(422, 'assist_no_usable_output', 'The assistant gave nothing we could use. Try again, or describe the data more concretely.');
        }
        d.log.info(`[CustomData] assist org=${orgId} type=${type.id} sentences=${clean.sentences.length} nearMisses=${clean.nearMisses.length} `
            + `patterns=${clean.candidates.patterns.length} labels=${clean.candidates.aiLabels.length} `
            + `dropped=${clean.dropped.sentences}/${clean.dropped.patterns}/${clean.dropped.labels}`);
        res.json({
            outbound: built.outbound,
            suggestedMethod: clean.suggestedMethod,
            sentences: clean.sentences,
            nearMisses: clean.nearMisses,
            candidates: clean.candidates,
            dropped: clean.dropped,
        });
    });

    router.post('/test', requireAuth, testLimiter, validate({ body: TestBody }), async (req, res) => {
        const { orgId } = await admit(req, d);
        noStore(res);
        const orgTypes = await orgTypesOf(d, orgId);
        const spec = await bench.normaliseDraft(d.engine, req.body.type, { orgId, orgTypes });
        const out = await bench.runTest({
            engine: d.engine, spec, sentences: benchSentences(req.body.sentences), orgTypes, tokenKey: req.body.type.tokenKey,
        });
        d.log.info(`[CustomData] test org=${orgId} type=${spec.id} method=${spec.method} sentences=${out.summary.sentences} engine=${out.engine}`);
        res.json(out);
    });

    router.post('/tune', requireAuth, tuneLimiter, validate({ body: TuneBody }), async (req, res) => {
        const { orgId } = await admit(req, d);
        noStore(res);
        const sentences = benchSentences(req.body.sentences);
        tune.assertEnoughGold(sentences);
        const orgTypes = await orgTypesOf(d, orgId);
        const spec = await bench.normaliseDraft(d.engine, req.body.type, { orgId, orgTypes });
        const out = await tune.tuneType({
            engine: d.engine,
            spec,
            sentences,
            examples: req.body.examples,
            candidates: req.body.candidates || {},
            orgTypes,
            validatePattern: (source, caseSensitive) => validatePattern(source, caseSensitive, { engine: d.engine }),
        });
        d.log.info(`[CustomData] tune org=${orgId} type=${spec.id} method=${spec.method} tried=${out.tried} improved=${out.improved}`);
        res.json(out);
    });

    return router;
}

const router = createCustomDataRouter();

module.exports = router;
module.exports.createCustomDataRouter = createCustomDataRouter;
