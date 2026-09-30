// @typecheck
'use strict';

/**
 * The project compliance hint — at most ONE gentle, dismissible suggestion for
 * the people who can act on it (compliance/projectHints.js has the rules).
 *
 *   GET  /:id/compliance-hints                 (viewer+) → { hint: null | { key, severity, titleKey,
 *                                                   params: { count }, action: { kind: 'navigate', target } } }
 *   POST /:id/compliance-hints/:key/dismiss    (editor+) {}            → { ok: true }
 *   POST /:id/compliance-hints/:key/snooze     (editor+) { days: 7|30 } → { ok: true }
 *
 * `{ hint: null }` is the answer for a viewer, when the compliance module is
 * not installed, when the organisation switched hints off
 * (`project_owner_hints_enabled`), when the checks never ran or their rows are
 * stale, and whenever anything on the way cannot be read — a hint is optional,
 * and its failure is a log line, never an error in a project page. A
 * dismissal is stored per person and project on the server, so it follows
 * them across web, desktop and phone.
 *
 * Factory router (`makeComplianceHintsRouter(deps)`); mounted under
 * /api/projects by the integration (routes/projects.js).
 */

const express = require('express');
const { z, bodyOf } = require('../../core/http/schemaParts');
const { validate } = require('../../core/http/validate');
const { lazyProjectRoleGate } = require('./roleGate');
const { HttpError } = require('../../core/http/errors');
const hints = require('../../compliance/projectHints');

const DAY_MS = 24 * 3600 * 1000;
const NO_ORG_ORG_ID = 'default';

const KeyParams = z.object({
    id: z.string(),
    key: z.enum(/** @type {[string, ...string[]]} */ ([...hints.HINT_KEYS]), {
        errorMap: () => ({ message: `key must be one of ${hints.HINT_KEYS.join(', ')}.` }),
    }),
}).strict();
const DismissBody = bodyOf({}, 'Dismissing a hint');
const SnoozeBody = bodyOf({
    days: z.union([z.literal(7), z.literal(30)], { errorMap: () => ({ message: 'days must be 7 or 30.' }) }).optional(),
}, 'Snoozing a hint');

function makeComplianceHintsRouter(deps = {}) {
    const router = express.Router({ mergeParams: true });

    const requireRole = deps.requireProjectRole || lazyProjectRoleGate;
    const getProject = (id) => (deps.getProject || require('../../stores/projectStore').getProject)(id);
    const complianceStore = () => deps.complianceStore || require('../../stores/complianceStore');
    const activeRegulations = (orgId) => (deps.activeRegulations
        || ((o) => require('../../compliance/frameworkPolicy').activeRegulations(o)))(orgId);
    const moduleAvailable = deps.moduleAvailable
        || (() => { try { return require('../../modules/catalog').isModuleAvailable('compliance'); } catch { return false; } });
    const defOf = (id) => {
        if (deps.checkDef) return deps.checkDef(id);
        try { return require('../../compliance/registry').get(id) || null; } catch { return null; }
    };
    const now = deps.now || (() => Date.now());
    const log = deps.log || require('../../telemetry/log');

    /** Every hint that applies now (before this person's dismissals), or [] on any failure. */
    async function currentCandidates(req) {
        if (!moduleAvailable()) return [];
        const project = await getProject(req.params.id);
        if (!project) throw new HttpError(404, 'not_found', 'Not found');
        const orgId = project.organizationId ? String(project.organizationId) : NO_ORG_ORG_ID;
        const store = complianceStore();
        const settings = await store.getSettings(orgId);
        if (settings && settings.project_owner_hints_enabled === false) return [];
        const [active, rows, states] = await Promise.all([
            activeRegulations(orgId),
            store.getLatestForChecks(orgId, hints.HINT_CHECK_IDS),
            store.listFindingStates(orgId).catch(() => []),
        ]);
        return hints.candidates({ projectId: String(project.id), role: req.projectRole, rows, active, states, now: now(), defs: defOf });
    }

    router.get('/:id/compliance-hints', requireRole('viewer'), async (req, res) => {
        if (req.projectRole === 'viewer') return res.json({ hint: null });
        let hint = null;
        try {
            const list = await currentCandidates(req);
            if (list.length) {
                const dismissals = await complianceStore().getHintDismissals(req.session.user.id, req.params.id);
                hint = hints.publicHint(hints.pick(list, dismissals, now()));
            }
        } catch (e) {
            if (e instanceof HttpError) throw e;
            log.warn(`[ProjectComplianceHints] project ${req.params.id}: no hint (${e?.message || e})`);
            hint = null;
        }
        res.json({ hint });
    });

    async function record(req, res, snoozeDays) {
        const list = await currentCandidates(req).catch((e) => {
            if (e instanceof HttpError) throw e;
            log.warn(`[ProjectComplianceHints] project ${req.params.id}: could not read hints to dismiss (${e?.message || e})`);
            return [];
        });
        const current = list.find(c => c.key === req.params.key);
        // Nothing showing under that key: nothing to put away. The answer is
        // the same, so a stale tab cannot tell a hint from no hint.
        if (current) {
            await complianceStore().recordHintDismissal(req.session.user.id, req.params.id, req.params.key, {
                fingerprint: current.fingerprint,
                snoozedUntil: snoozeDays ? new Date(now() + snoozeDays * DAY_MS).toISOString() : null,
            });
        }
        res.json({ ok: true });
    }

    router.post('/:id/compliance-hints/:key/dismiss', requireRole('editor'),
        validate({ params: KeyParams, body: DismissBody }),
        (req, res) => record(req, res, null));

    router.post('/:id/compliance-hints/:key/snooze', requireRole('editor'),
        validate({ params: KeyParams, body: SnoozeBody }),
        (req, res) => record(req, res, req.body?.days || 7));

    return router;
}

module.exports = makeComplianceHintsRouter();
module.exports.makeComplianceHintsRouter = makeComplianceHintsRouter;
