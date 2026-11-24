// @typecheck strict
/**
 * An organisation's Cowork policy, under /api/cowork (./coworkSideRoutes.js mounts it before the item routes):
 *
 *   GET /policy/mine          → the policy of the caller's own organisation (the open one without an organisation),
 *                               so the app picker offers only apps that may run while nobody watches
 *   GET /policy/:orgId        → the policy (members of the organisation)
 *   PUT /policy/:orgId        → change it: the ceiling on independence, read-only, the apps that may run unattended,
 *                               the monthly AI budget of all its coworks, whether Cowork may fix a broken
 *                               reference by itself (`autoFix`)
 *                               (organisation administrators; recorded as `cowork_policy.set`)
 *   GET /policy/:orgId/audit  → the trail of every Cowork change in the organisation, as CSV (administrators).
 *                               Ids, actions, times and the names of the fields that changed: never what the work says.
 *
 * The policy itself is core/entitlements/coworkPolicy.mts.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, isOrgAdminForOrg } = require('../auth/permissions');
const { resolveUserOrgIds } = require('../auth');
const { validate } = require('../core/http/validate');
const { z, flag } = require('../core/http/schemaParts');
const { sessionUser } = require('../core/http/sessionUser');

const policyModule = () => require('../core/entitlements/coworkPolicy.mts');

const LEVEL_TEXT = 'ceiling is asks_everything, asks_before_sending or on_its_own.';
const APPS_TEXT = 'unattendedApps is a list of app ids, or null for every app.';
const BUDGET_TEXT = 'monthlyBudget is an amount in euros above 0, or null for no limit.';
const PolicyBody = z.object({
    ceiling: z.enum(['asks_everything', 'asks_before_sending', 'on_its_own'], { error: LEVEL_TEXT }).optional(),
    readOnly: flag('readOnly is true or false.').optional(),
    unattendedApps: z.array(z.string({ error: APPS_TEXT }).min(1, { error: APPS_TEXT }).max(100, { error: APPS_TEXT }), { error: APPS_TEXT }).max(200, { error: APPS_TEXT }).nullable().optional(),
    monthlyBudget: z.number({ error: BUDGET_TEXT }).positive({ error: BUDGET_TEXT }).max(10_000_000, { error: BUDGET_TEXT }).nullable().optional(),
    habitsAllowed: flag('habitsAllowed is true or false.').optional(),
    // Cowork may fix a broken reference between a plan's own steps by itself (core/cowork/repairs/autoResolve.mts).
    autoFix: flag('autoFix is true or false.').optional(),
}).strict();

/** Members read; a platform admin (null) reads every organisation. @param {import('express').Request<{ orgId: string }>} req */
async function isMember(req) {
    const orgIds = await resolveUserOrgIds(req);
    return orgIds === null || orgIds.has(req.params.orgId);
}

router.get('/policy/mine', requireAuth, async (req, res) => {
    res.json(await policyModule().policyOfOwner(sessionUser(req).id));
});

router.get('/policy/:orgId', requireAuth, async (/** @type {import('express').Request<{ orgId: string }>} */ req, res) => {
    if (!(await isMember(req))) return res.status(403).json({ error: 'Not a member of this organization' });
    res.json(await policyModule().resolveCoworkPolicy(req.params.orgId));
});

router.put('/policy/:orgId', requireAuth, validate({ body: PolicyBody }), async (/** @type {import('express').Request<{ orgId: string }>} */ req, res) => {
    const { orgId } = req.params;
    if (!(await isOrgAdminForOrg(req, orgId))) return res.status(403).json({ error: 'Only organization admins can change this.' });
    const saved = await policyModule().setCoworkPolicy(orgId, req.body);
    await require('../stores/userStore').logAccessAudit('cowork_policy.set', 'organization', orgId, sessionUser(req).id, null, saved, orgId);
    res.json(saved);
});

const FORMULA_START = '=+-@\t\r';

/** One CSV cell: quoted, quotes doubled, and a leading formula character neutralised. @param {unknown} value */
function cell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    const safe = FORMULA_START.includes(text.charAt(0)) && text !== '' ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
}

const EXPORT_LIMIT = 10_000;

router.get('/policy/:orgId/audit', requireAuth, async (/** @type {import('express').Request<{ orgId: string }>} */ req, res) => {
    const { orgId } = req.params;
    if (!(await isOrgAdminForOrg(req, orgId))) return res.status(403).json({ error: 'Only organization admins can export this.' });
    const rows = await require('../stores/userStore').getAccessAuditLog({ targetType: 'cowork_item', organizationId: orgId, limit: EXPORT_LIMIT });
    const lines = [['at', 'action', 'item', 'by', 'changed'].map(cell).join(',')];
    for (const row of rows) {
        const changed = Array.isArray(row.new_values?.changed) ? row.new_values.changed.join(' ') : '';
        const at = row.created_at ? new Date(row.created_at).toISOString() : '';
        lines.push([at, row.action, row.target_id, row.changed_by, changed].map(cell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cowork-audit-${orgId}.csv"`);
    res.send(`${lines.join('\n')}\n`);
});

module.exports = router;
