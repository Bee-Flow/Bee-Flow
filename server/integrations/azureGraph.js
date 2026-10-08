'use strict';
const { GUID } = require('../auth/microsoftIdentity');
async function getClientCredentialsToken(clientId, clientSecret, tenantId) {
    if (!GUID.test(tenantId || '')) throw new Error('Azure group sync requires a concrete tenant GUID');
    const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' }).toString(),
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Azure directory authentication failed (${response.status})`);
    const data = await response.json();
    if (!data.access_token) throw new Error('Azure directory returned no access token');
    return data.access_token;
}
async function graphGet(path, token) {
    const url = new URL(path, 'https://graph.microsoft.com/v1.0/');
    if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/')) throw new Error('Invalid Graph pagination URL');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Graph directory read failed (${response.status})`);
    return response.json();
}
async function graphGetAll(path, token) {
    const results = [];
    const seen = new Set();
    for (let next = path; next;) {
        if (seen.has(next) || seen.size >= 10000) throw new Error('Invalid Graph pagination');
        seen.add(next);
        const data = await graphGet(next, token);
        if (!Array.isArray(data.value)) throw new Error('Incomplete Graph directory response');
        results.push(...data.value);
        next = data['@odata.nextLink'];
    }
    return results;
}
async function getAppRoleAssignments(token, clientId) {
    const principal = await graphGet(`servicePrincipals?$filter=appId eq '${clientId}'&$select=id`, token);
    if (principal.value?.length !== 1) throw new Error('Microsoft enterprise application not found');
    return graphGetAll(`servicePrincipals/${principal.value[0].id}/appRoleAssignedTo`, token);
}
const getGroupMembers = (token, id) => graphGetAll(`groups/${id}/members?$select=id,displayName,givenName,surname,mail,userPrincipalName`, token)
    .then(members => members.filter(m => m['@odata.type'] === '#microsoft.graph.user' || !m['@odata.type']));
module.exports = { getClientCredentialsToken, graphGet, graphGetAll, getAppRoleAssignments, getGroupMembers };
