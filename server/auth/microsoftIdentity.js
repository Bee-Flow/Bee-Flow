'use strict';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
let keys;

async function verifyMicrosoftIdentity(token, { clientId, tenantId = 'common', nonce }, seams = {}) {
    if (!token || !nonce || !clientId) throw new Error('Missing Microsoft identity proof');
    const jose = await import('jose');
    // Only use the untrusted tenant to construct an expected issuer on the
    // fixed Microsoft host, never to fetch an attacker-provided JWKS URL.
    const untrusted = jose.decodeJwt(token);
    if (!GUID.test(untrusted.tid) || !GUID.test(untrusted.oid)) throw new Error('Invalid Microsoft identity');
    const tid = untrusted.tid.toLowerCase();
    const configured = tenantId.toLowerCase();
    if (GUID.test(configured) && configured !== tid) throw new Error('Microsoft tenant mismatch');
    if (!GUID.test(configured) && !['common', 'organizations', 'consumers'].includes(configured)) throw new Error('Invalid Microsoft tenant policy');
    if (configured === 'organizations' && tid === CONSUMER_TENANT) throw new Error('Microsoft organization account required');
    if (configured === 'consumers' && tid !== CONSUMER_TENANT) throw new Error('Microsoft personal account required');
    const jwks = seams.jwks || (keys ||= jose.createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'), { timeoutDuration: 10000 }));
    const { payload } = await jose.jwtVerify(token, jwks, {
        algorithms: ['RS256'], audience: clientId,
        issuer: `https://login.microsoftonline.com/${tid}/v2.0`,
        requiredClaims: ['exp', 'iat', 'nbf', 'sub', 'tid', 'oid', 'nonce'], clockTolerance: 30,
    });
    if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)
        || payload.iat > Math.floor(Date.now() / 1000) + 30 || payload.exp <= payload.iat || payload.nbf > payload.exp) throw new Error('Invalid Microsoft token lifetime');
    if (payload.nonce !== nonce) throw new Error('Microsoft nonce mismatch');
    return { azureTenantId: tid, azureUserId: payload.oid.toLowerCase() };
}

function assertGraphIdentity(identity, graphId) {
    if (!GUID.test(graphId) || graphId.toLowerCase() !== identity.azureUserId) throw new Error('Microsoft Graph identity mismatch');
}

// Old Microsoft logins (including bridge/native tokens) must reauthenticate.
// A connected mailbox is not an SSO login and is deliberately unaffected.
function isMicrosoftLoginSession(session) {
    return !!(session?.isAuthenticated && (session.microsoftIdentityVersion !== undefined
        || session.microsoftLoginIdentity !== undefined || session.user?.provider === 'microsoft'
        || (session.oauthProvider === 'microsoft' && session.oauthTokenSource !== 'connector')));
}
function isLegacyMicrosoftSession(session) {
    const identity = session?.microsoftLoginIdentity;
    return isMicrosoftLoginSession(session) && (session.microsoftIdentityVersion !== 2
        || !session.user?.id || !GUID.test(identity?.azureTenantId || '') || !GUID.test(identity?.azureUserId || '')
        || typeof identity?.revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(identity.revision));
}
module.exports = { GUID, verifyMicrosoftIdentity, assertGraphIdentity, isMicrosoftLoginSession, isLegacyMicrosoftSession };
