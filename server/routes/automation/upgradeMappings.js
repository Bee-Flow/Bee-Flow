/**
 * "Koppelingen bijwerken" (M8 of the data-mapping work): upgrade the stored
 * mappings of one routine to picks, only where its value stays the same.
 *
 *   POST /:id/upgrade-mappings?dryRun=1   the preview: what would change,
 *                                         what stays a Formula and why
 *   POST /:id/upgrade-mappings            apply it: a new version
 *       body { version? }                 the version the preview was of;
 *                                         a routine saved since is refused
 *
 * Same gate as PUT /:id: the routine must exist and the caller needs `edit`.
 * The rewrite is automation/mappingUpgrade.js (over shared/mapping
 * upgradeDefinition), dry-run against the routine's recent live runs and its
 * pinned samples. The answer names steps, fields and labels, never a value
 * from a run. Nothing is written on a dry run, nor when nothing changes.
 *
 * Literal second segment, so the mount position in routes/automation.js is
 * free. Built by a factory so a test hands in its own store, access guard and
 * validator; the default router uses the real ones, required lazily.
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { makeGuardedLoad } = require('./guardedLoad');

const DRY_RUN_TEXT = 'dryRun is 1, true, 0 or false.';
const Query = z.object({
    dryRun: z.enum(['1', 'true', '0', 'false'], { errorMap: () => ({ message: DRY_RUN_TEXT }) }).optional(),
}).strict();
const VERSION_TEXT = 'version is the version number the preview was made of.';
const Body = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    version: z.number({ invalid_type_error: VERSION_TEXT }).int(VERSION_TEXT).positive(VERSION_TEXT).optional(),
}).strict());

/** The report as the client reads it. */
function summary(result) {
    return {
        changed: result.changed,
        kept: result.kept,
        counts: { changed: result.changed.length, kept: result.kept.length },
        evidence: result.evidence,
    };
}

/**
 * @param {{
 *   store?: object, access?: { guard: Function },
 *   upgrade?: (automation: object, store: object) => Promise<{ definition: object, changed: object[], kept: object[], evidence: object }>,
 *   validateDefinition?: (def: object, opts: object) => { ok: boolean, errors?: object[] },
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

    router.post('/:id/upgrade-mappings', validate({ body: Body, query: Query }), async (req, res) => {
        const loaded = await load(req, res, 'edit');
        if (!loaded) return;
        const { a, acc } = loaded;
        const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
        if (!a.definition || typeof a.definition !== 'object' || !Array.isArray(a.definition.steps)) {
            throw new HttpError(400, 'no_definition', 'This routine has no steps to update.');
        }
        const result = await upgrade(a, store());
        if (dryRun) {
            res.json({ dryRun: true, version: a.version ?? null, saved: false, ...summary(result) });
            return;
        }
        // The preview was of one version; applying it to a routine saved
        // since would apply something nobody looked at.
        if (req.body.version !== undefined && a.version != null && req.body.version !== a.version) {
            throw new HttpError(409, 'version_changed', 'This routine changed since the preview. Look at the preview again.');
        }
        if (!result.changed.length) {
            res.json({ dryRun: false, version: a.version ?? null, saved: false, automation: projectForViewer(a, acc), ...summary(result) });
            return;
        }
        // The upgrade only swaps bindings for ones that read the same, so a
        // definition that passed PUT /:id passes again; checked anyway, as
        // every write of a definition is.
        const v = validateDefinition(result.definition, { stage: 'draft' });
        if (!v.ok) {
            throw new HttpError(400, 'invalid_definition', 'The updated mappings did not pass the checks, so nothing was changed.', v.errors);
        }
        // Only bindings change: no trigger, schedule, table or knowledge
        // base, so nothing PUT /:id keeps in step follows from this write.
        const n = result.changed.length;
        const updated = await store().updateAutomation(a.id, { definition: result.definition }, req.session.user.id, {
            versionMeta: {
                description: `Mappings updated (${n} field${n === 1 ? '' : 's'})`,
                descriptionJson: [{ code: 'mappings_upgraded', params: { count: n } }],
            },
        });
        const row = updated || a;
        res.json({ dryRun: false, version: row.version ?? null, saved: true, automation: projectForViewer(row, acc), ...summary(result) });
    });

    return router;
}

module.exports = { makeUpgradeMappingsRouter };
