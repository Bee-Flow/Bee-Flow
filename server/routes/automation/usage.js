/**
 * "Frequently used" in the builder (Studio → Automations handoff 5).
 *
 *   GET /_usage/steps                         org-wide step kinds + actions, most used first
 *   GET /_usage/values?tool=<tool>&input=<k>  the top 5 literal values the org typed into
 *                                             that setting of that action
 *
 * Both read the saved definitions of the caller's organisation (or, on a
 * personal install, the caller's own routines) through
 * automation/orgStepUsage.js, which caches per organisation for a few minutes
 * and never returns a value that looks like personal data or a credential.
 *
 * Mounted after every other automation router: both paths start with a
 * literal `_usage` segment, and no earlier route has a `/:id/steps` or
 * `/:id/values` GET that could shadow them.
 *
 * Handlers come from a factory so a test can hand them a usage source and a
 * scope resolver of its own.
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');

const NAME_TEXT = (what) => `${what} is a name of letters, digits, "_", ".", ":" or "-", at most 120 characters.`;
const name = (what) => z.string({ required_error: `${what} is required.`, invalid_type_error: NAME_TEXT(what) })
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/, NAME_TEXT(what));

const ValuesQuery = z.object({
    tool: name('tool'),
    // The setting's input name; 'inputs.path' is read as 'path'.
    input: name('input').transform((s) => s.replace(/^inputs\./, '')),
});

/**
 * @param {{
 *   usage?: { stepUsage: Function, valueUsage: Function },
 *   resolveScope?: (req: any) => Promise<{ orgId: string|null, userId: string }>,
 * }} [overrides]
 */
function makeUsageRouter(overrides = {}) {
    const router = express.Router();
    let usage = overrides.usage || null;
    const usageSource = () => {
        if (!usage) usage = require('../../automation/orgStepUsage').makeOrgStepUsage();
        return usage;
    };
    const resolveScope = overrides.resolveScope || (async (req) => {
        const { resolveDatatablePrincipal } = require('../../auth/datatableAccess');
        const { orgId } = await resolveDatatablePrincipal(req);
        return { orgId: orgId || null, userId: req.session.user.id };
    });

    router.get('/_usage/steps', async (req, res) => {
        const rows = await usageSource().stepUsage(await resolveScope(req));
        res.set('Cache-Control', 'private, max-age=60');
        res.json(rows);
    });

    router.get('/_usage/values', validate({ query: ValuesQuery }), async (req, res) => {
        const rows = await usageSource().valueUsage(await resolveScope(req), req.query.tool, req.query.input);
        res.set('Cache-Control', 'private, max-age=60');
        res.json(rows);
    });

    return router;
}

module.exports = { makeUsageRouter };
