/**
 * A stand-in for the access guard the automation routers take
 * (`makeXRouter({ access })`, see automation/access.js), for route tests:
 * each caller's role comes from a fixed table instead of shares and org
 * lookups. The rank order is the product's own (roleSatisfies), and a refusal
 * is the 403 the real guard sends.
 *
 *   const access = accessByRole({ owner: 'owner', ed: 'edit', vic: 'view', ron: 'run' });
 *   makeActionsRouter({ store, access, ... });
 */

'use strict';

const { roleSatisfies } = require('../../../automation/access');

/** @param {Record<string, 'owner'|'edit'|'view'|'run'>} rolesByUserId */
function accessByRole(rolesByUserId) {
    return {
        async guard(req, res, _automation, need) {
            const role = rolesByUserId[req.session.user.id];
            if (roleSatisfies(role, need)) return { role, via: role === 'owner' ? 'owner' : 'share' };
            res.status(403).json({ error: 'Forbidden', code: 'automation_forbidden', need });
            return null;
        },
    };
}

module.exports = { accessByRole };
