'use strict';
const { isMicrosoftLoginSession, isLegacyMicrosoftSession } = require('./microsoftIdentity');
const checked = Symbol('Microsoft identity checked for this request');

function createMicrosoftSessionMiddleware({ getIdentityBinding }) {
    return async function validateMicrosoftSession(req, res, next) {
        const session = req.session;
        if (!isMicrosoftLoginSession(session) || req[checked] === session) return next();
        let revoked = isLegacyMicrosoftSession(session);
        if (!revoked) {
            let binding;
            try { binding = await getIdentityBinding(session.user.id); }
            catch { return res.status(503).json({ error: 'auth_unavailable' }); }
            const proof = session.microsoftLoginIdentity;
            revoked = !binding || binding.azureTenantId !== proof.azureTenantId
                || binding.azureUserId !== proof.azureUserId || binding.revision !== proof.revision;
        }
        if (revoked) {
            if (typeof session.destroy === 'function') session.destroy(() => {});
            return res.status(401).json({ error: 'Sign in with Microsoft again', code: 'sso_reauthentication_required' });
        }
        req[checked] = session;
        return next();
    };
}
let middleware;
function validateMicrosoftSession(req, res, next) {
    middleware ||= createMicrosoftSessionMiddleware({ getIdentityBinding: (...args) =>
        require('../stores/microsoftIdentityStore').getIdentityBinding(...args) });
    return middleware(req, res, next);
}
module.exports = { createMicrosoftSessionMiddleware, validateMicrosoftSession };
