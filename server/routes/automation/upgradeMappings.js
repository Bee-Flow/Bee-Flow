/**
 * "Koppelingen bijwerken" (M8 of the data-mapping work): upgrade the stored
 * mappings of one routine to picks, only where its value stays the same.
 *
 *   POST /:id/upgrade-mappings?dryRun=1   the preview: what would change,
 *                                         what stays a Formula and why
 *   POST /:id/upgrade-mappings            apply it: a new version
 *       body { version?, aiFixes?, auto? }
 *            version   the version the preview was of; a routine saved
 *                      since is refused
 *            aiFixes   AI suggestions the person ticked ([{ stepId, field,
 *                      binding }], from /ai-fix): each one dry-run again,
 *                      all or nothing (409 ai_fix_changed)
 *            auto      the builder applying it because the automation was
 *                      opened (M8b): only when the organisation switched
 *                      that on (automation/mappingSettings.js), otherwise a
 *                      200 that saves nothing (`autoOff: true`). Never with
 *                      aiFixes: an AI suggestion is applied by a person.
 *   POST /:id/upgrade-mappings/ai-fix     M8b: ask the fast-tier model for
 *       body { version? }                 a pick or compose for each field
 *                                         that stays a Formula; only what a
 *                                         dry run on every runState shows
 *                                         gives the same result comes back
 *                                         (automation/mappingAiFix.js).
 *                                         Nothing is written.
 *
 * Same gate as PUT /:id: the routine must exist and the caller needs `edit`.
 * The licence gate is the mount's (index.js: requireLicenseFeature
 * ('automations') on /api/automation, as on the AI builder's own routes); the
 * AI fix is rate limited per user and writes one usage row per model call,
 * as the form drafter does (routes/automation/formsAi.js). The rewrite is
 * automation/mappingUpgrade.js (over shared/mapping upgradeDefinition),
 * dry-run against the routine's recent live runs and its pinned samples. The
 * answer names steps, fields and labels, never a value from a run. Nothing
 * is written on a dry run, nor when nothing changes. A save answers with
 * `previous` (the version before it, and its row id) so the builder can
 * offer Undo through the version restore.
 *
 * Literal second segment, so the mount position in routes/automation.js is
 * free. Built by a factory so a test hands in its own store, access guard and
 * validator; the default router uses the real ones, required lazily.
 */

'use strict';

const { isDeepStrictEqual } = require('node:util');
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { makeGuardedLoad } = require('./guardedLoad');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
// automation/mappingAiFix.js MAX_FIELDS: a request cannot apply more than one call suggests.
const MAX_FIELDS = 40;
const log = require('../../telemetry/log');

const DRY_RUN_TEXT = 'dryRun is 1, true, 0 or false.';
const Query = z.object({
    dryRun: z.enum(['1', 'true', '0', 'false'], { errorMap: () => ({ message: DRY_RUN_TEXT }) }).optional(),
}).strict();
const VERSION_TEXT = 'version is the version number the preview was made of.';
const version = z.number({ invalid_type_error: VERSION_TEXT }).int(VERSION_TEXT).positive(VERSION_TEXT).optional();
const FIX_TEXT = 'aiFixes is the list of AI suggestions to apply: { stepId, field, binding } each.';
const AiFix = z.object({
    stepId: z.string({ required_error: FIX_TEXT, invalid_type_error: FIX_TEXT }).min(1, FIX_TEXT).max(200, FIX_TEXT),
    field: z.string({ required_error: FIX_TEXT, invalid_type_error: FIX_TEXT }).min(1, FIX_TEXT).max(500, FIX_TEXT),
    binding: z.record(z.unknown(), { required_error: FIX_TEXT, invalid_type_error: FIX_TEXT }),
}, { invalid_type_error: FIX_TEXT }).strict();
const Body = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    version,
    aiFixes: z.array(AiFix, { invalid_type_error: FIX_TEXT }).max(MAX_FIELDS, `At most ${MAX_FIELDS} AI suggestions at once.`).optional(),
    auto: z.boolean({ invalid_type_error: 'auto is true or false.' }).optional(),
}).strict().refine(b => !(b.auto && b.aiFixes && b.aiFixes.length), {
    message: 'An AI suggestion is only applied by a person: auto cannot carry aiFixes.', path: ['aiFixes'],
}));
const AiFixBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({ version }).strict());

/** The report as the client reads it (never `states`: that is run data). */
function summary({ changed, kept, evidence }) {
    return {
        changed,
        kept,
        counts: { changed: changed.length, kept: kept.length },
        evidence,
    };
}

/** One model call a minute's worth of reading per person: ten a minute is plenty. */
const AI_FIX_RATE = { windowMs: 60_000, max: 10 };
const AI_FIX_MAX_TOKENS = 4000;

/** One usage row per AI fix call: `chatForcedTool` logs nothing itself (as formsAi.js). */
async function logAiFixUsage({ userId, userOrgId, automationId, modelId, usage, startMs }) {
    try {
        const { usageLogFields } = require('../../core/providers/usageNormalizer');
        await require('../../stores/usageStore').logUsage({
            user_id: userId,
            agent_id: automationId,
            agent_name: 'mapping-ai-fix',
            agent_type: 'system',
            model: modelId,
            ...usageLogFields(usage),
            source: 'mapping_ai_fix',
            duration_ms: Date.now() - startMs,
            organization_id: userOrgId || null,
        });
    } catch (e) {
        log.warn('[Automation/upgrade-mappings] failed to log AI fix usage:', e.message);
    }
}

/**
 * @param {{
 *   store?: object, access?: { guard: Function },
 *   upgrade?: (automation: object, store: object) => Promise<{ definition: object, changed: object[], kept: object[], evidence: object, states?: object }>,
 *   validateDefinition?: (def: object, opts: object) => { ok: boolean, errors?: object[] },
 *   mappingSettings?: { readMappingSettings: (orgId: string|null) => Promise<{ autoUpgradeOnOpen: boolean }> },
 *   orgIdOf?: (req: object) => Promise<string|null>,
 *   resolveModel?: (ctx: { userId: string, userOrgId: string|null }) => Promise<string|null>,
 *   chat?: (modelId: string, messages: object[], tool: object, opts: object) => Promise<{ structured?: object|null, usage?: object }>,
 *   logUsage?: (row: object) => Promise<void>,
 *   rateLimit?: { windowMs: number, max: number },
 * }} [overrides]
 */
function makeUpgradeMappingsRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const { makeAutomationAccess, projectForViewer } = require('../../automation/access');
    const access = overrides.access || makeAutomationAccess(overrides.store ? { store: overrides.store } : {});
    const upgrade = overrides.upgrade
        || ((a, s) => require('../../automation/mappingUpgrade').upgradeAutomationMappings(a, s));
    const validateDefinition = overrides.validateDefinition
        || ((def, opts) => require('../../automation/validate').validateDefinition(def, opts));
    const load = makeGuardedLoad(store, access);
    const mappingSettings = () => overrides.mappingSettings || require('../../automation/mappingSettings');
    const aiFix = () => require('../../automation/mappingAiFix');
    const orgIdOf = overrides.orgIdOf || ((req) => require('./formsAi').orgIdOf(req));
    const resolveModel = overrides.resolveModel || ((ctx) => require('./formsAi').resolveModel(ctx));
    const chat = overrides.chat
        || ((modelId, messages, tool, opts) => require('../../core/llm/llmClient').chatForcedTool(modelId, messages, tool, opts));
    const logUsage = overrides.logUsage || logAiFixUsage;
    const aiFixLimiter = perUserRateLimit(overrides.rateLimit || AI_FIX_RATE);

    /** The preview was of one version; anything saved since is something nobody looked at. */
    function assertVersion(req, a) {
        if (req.body.version !== undefined && a.version != null && req.body.version !== a.version) {
            throw new HttpError(409, 'version_changed', 'This routine changed since the preview. Look at the preview again.');
        }
    }

    function assertSteps(a) {
        if (!a.definition || typeof a.definition !== 'object' || !Array.isArray(a.definition.steps)) {
            throw new HttpError(400, 'no_definition', 'This routine has no steps to update.');
        }
    }

    /**
     * The version a save replaces, for Undo: its number and its row id. The
     * row id only when that row holds exactly the definition this save
     * replaces: a layout-only write gets no version row of its own
     * (planVersionWrite), so the row of `a.version` can be older than what is
     * live, and restoring it would undo more than this update.
     */
    async function previousOf(a) {
        if (a.version == null) return null;
        let row = null;
        try {
            if (typeof store().getVersionByNumber === 'function') row = await store().getVersionByNumber(a.id, a.version);
        } catch (e) {
            log.warn(`[Automation/upgrade-mappings] previous version of ${a.id}: ${e.message}`);
        }
        const same = !!(row && row.id) && isDeepStrictEqual(row.definition, a.definition);
        return { version: a.version, versionId: same ? row.id : null };
    }

    // Literal third segment, registered before the apply route below only
    // for reading order: the two paths cannot collide.
    router.post('/:id/upgrade-mappings/ai-fix', aiFixLimiter, validate({ body: AiFixBody }), async (req, res) => {
        const loaded = await load(req, res, 'edit');
        if (!loaded) return;
        const { a } = loaded;
        assertSteps(a);
        assertVersion(req, a);
        const result = await upgrade(a, store());
        const userId = req.session.user.id;
        const userOrgId = await orgIdOf(req);
        let modelId = null;
        let usage = null;
        const startMs = Date.now();
        let answer;
        try {
            answer = await aiFix().suggestAiFixes(result, async (messages, tool) => {
                modelId = await resolveModel({ userId, userOrgId });
                if (!modelId) throw new HttpError(503, 'no_model', 'No AI model is configured for this workspace.');
                const out = await chat(modelId, messages, tool, { maxTokens: AI_FIX_MAX_TOKENS, temperature: 0, reasoningEffort: 'none', budgetTokens: 0 });
                usage = out && out.usage;
                return out;
            });
        } catch (err) {
            if (err instanceof HttpError) throw err;
            // The message only: a prompt holds the routine's own formulas.
            log.error('[Automation/upgrade-mappings] AI fix failed:', err.message);
            throw new HttpError(502, 'ai_unavailable', 'Bee could not ask the AI right now. Nothing was changed. Try again in a moment.');
        } finally {
            if (modelId) await logUsage({ userId, userOrgId, automationId: a.id, modelId, usage, startMs });
        }
        res.json({ version: a.version ?? null, suggestions: answer.suggestions, counts: answer.counts });
    });

    router.post('/:id/upgrade-mappings', validate({ body: Body, query: Query }), async (req, res) => {
        const loaded = await load(req, res, 'edit');
        if (!loaded) return;
        const { a, acc } = loaded;
        const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
        assertSteps(a);
        // Opened, not asked: only where the organisation switched that on.
        // Checked before anything is read, so an organisation that did not
        // costs one config read per open.
        if (!dryRun && req.body.auto) {
            const settings = await mappingSettings().readMappingSettings(a.organizationId || null);
            if (!settings.autoUpgradeOnOpen) {
                res.json({ dryRun: false, version: a.version ?? null, saved: false, autoOff: true });
                return;
            }
        }
        const result = await upgrade(a, store());
        if (dryRun) {
            res.json({ dryRun: true, version: a.version ?? null, saved: false, ...summary(result) });
            return;
        }
        // The preview was of one version; applying it to a routine saved
        // since would apply something nobody looked at.
        assertVersion(req, a);
        let definition = result.definition;
        let changed = result.changed;
        let kept = result.kept;
        const fixes = req.body.aiFixes || [];
        if (fixes.length) {
            // Checked again on the data as it is now: a run that came in
            // since the suggestion may show it differs after all.
            const r = aiFix().applyAiFixes(result, fixes);
            if (r.refused) {
                throw new HttpError(409, 'ai_fix_changed', 'An AI suggestion no longer gives the same result. Nothing was changed; check again.', [r.refused]);
            }
            definition = r.definition;
            changed = [...changed, ...r.applied];
            const fixed = new Set(r.applied.map(e => `${e.stepId}\u0000${e.field}`));
            kept = kept.filter(e => !fixed.has(`${e.stepId}\u0000${e.field}`));
        }
        const report = { changed, kept, evidence: result.evidence };
        if (!changed.length) {
            res.json({ dryRun: false, version: a.version ?? null, saved: false, automation: projectForViewer(a, acc), ...summary(report) });
            return;
        }
        // The upgrade only swaps bindings for ones that read the same, so a
        // definition that passed PUT /:id passes again; checked anyway, as
        // every write of a definition is.
        const v = validateDefinition(definition, { stage: 'draft' });
        if (!v.ok) {
            throw new HttpError(400, 'invalid_definition', 'The updated mappings did not pass the checks, so nothing was changed.', v.errors);
        }
        // Only bindings change: no trigger, schedule, table or knowledge
        // base, so nothing PUT /:id keeps in step follows from this write.
        const n = changed.length;
        const ai = fixes.length;
        const previous = await previousOf(a);
        const updated = await store().updateAutomation(a.id, { definition }, req.session.user.id, {
            versionMeta: {
                description: `Mappings updated (${n} field${n === 1 ? '' : 's'})`,
                descriptionJson: [{ code: 'mappings_upgraded', params: { count: n, ...(ai ? { ai } : {}), ...(req.body.auto ? { auto: true } : {}) } }],
            },
        });
        const row = updated || a;
        res.json({ dryRun: false, version: row.version ?? null, saved: true, previous, automation: projectForViewer(row, acc), ...summary(report) });
    });

    return router;
}

module.exports = { makeUpgradeMappingsRouter };
