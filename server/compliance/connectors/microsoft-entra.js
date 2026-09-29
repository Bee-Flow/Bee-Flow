/**
 * Microsoft Entra ID (Azure AD) directory connector — identity-population
 * evidence for the access-management controls (A.5.16/A.5.18/A.8.2) via
 * Microsoft Graph, app-only.
 *
 * Credential (vault provider 'microsoft-entra', kind oauth2_cc), read
 * defensively: { tenantId, clientId, clientSecret } (snake_case accepted).
 * Client-credentials flow against login.microsoftonline.com with scope
 * https://graph.microsoft.com/.default — same token pattern as
 * integrations/azureGroupSync.js.
 *
 * Graph APPLICATION permissions per payload field (optional signals degrade
 * to null instead of failing the sweep):
 *   users / enabled  User.Read.All (required — the sweep fails without it)
 *   dormant_90d      User.Read.All + AuditLog.Read.All ($select=signInActivity)
 *   admins           RoleManagement.Read.Directory or Directory.Read.All
 *                    (activated directoryRoles → Global Administrator members)
 *   mfa_capable      AuditLog.Read.All + an Entra ID P1/P2 licence
 *                    (/reports/authenticationMethods/userRegistrationDetails)
 *
 * Depth: ONE 500-user page plus counts — aggregate numbers only, no names or
 * e-mail addresses in the snapshot. `sample_size`/`truncated` make the
 * first-page sampling honest for tenants above 500 users.
 */

const LOGIN_BASE = 'https://login.microsoftonline.com';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DORMANT_MS = 90 * 86400000;
// Well-known role template id of "Global Administrator".
const GLOBAL_ADMIN_TEMPLATE_ID = '62e90394-69f5-4237-9190-012177145e10';

async function _token(secret, safeFetch) {
    const tenantId = secret?.tenantId || secret?.tenant_id;
    const clientId = secret?.clientId || secret?.client_id;
    const clientSecret = secret?.clientSecret || secret?.client_secret;
    if (!tenantId || !clientId || !clientSecret) {
        throw new Error('microsoft-entra secret needs { tenantId, clientId, clientSecret }');
    }
    const res = await safeFetch(`${LOGIN_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
            scope: 'https://graph.microsoft.com/.default',
        }).toString(),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Entra token acquisition failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.access_token) throw new Error('Entra token acquisition returned no access_token');
    return data.access_token;
}

async function _graphJson(path, token, safeFetch, extraHeaders = {}) {
    const res = await safeFetch(`${GRAPH_BASE}${path}`, {
        headers: { 'Authorization': `Bearer ${token}`, ...extraHeaders },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Graph ${path.split('?')[0]} failed (${res.status}): ${body.slice(0, 150)}`);
    }
    return res.json();
}

module.exports = {
    id: 'microsoft-entra',
    titleKey: 'compliance.connector.microsoft_entra.title',
    descKey: 'compliance.connector.microsoft_entra.desc',
    coveredControls: ['A.5.16', 'A.5.18', 'A.8.2'],
    checks: ['ISO27001-A.5.16-identity-hygiene'],
    credential: { provider: 'microsoft-entra', kinds: ['oauth2_cc'] },
    settingsHint: 'no settings — tenant comes from the linked credential',

    async collect({ secret, safeFetch }) {
        const token = await _token(secret, safeFetch);

        // Users page — signInActivity needs AuditLog.Read.All; retry without
        // it so a missing report permission degrades instead of failing.
        let page = null;
        let signInAvailable = true;
        try {
            page = await _graphJson('/users?$select=accountEnabled,signInActivity&$top=500', token, safeFetch);
        } catch {
            signInAvailable = false;
            page = await _graphJson('/users?$select=accountEnabled&$top=500', token, safeFetch);
        }
        const sample = Array.isArray(page?.value) ? page.value : [];
        const cutoff = Date.now() - DORMANT_MS;
        let enabled = 0;
        let dormant = 0;
        for (const u of sample) {
            if (!u.accountEnabled) continue;
            enabled++;
            if (!signInAvailable) continue;
            const last = u.signInActivity?.lastSignInDateTime
                ? Date.parse(u.signInActivity.lastSignInDateTime) : NaN;
            if (!Number.isFinite(last) || last < cutoff) dormant++;
        }

        // Tenant-wide user count (User.Read.All + ConsistencyLevel: eventual);
        // fall back to the sampled page length.
        let userCount = sample.length;
        try {
            const res = await safeFetch(`${GRAPH_BASE}/users/$count`, {
                headers: { 'Authorization': `Bearer ${token}`, 'ConsistencyLevel': 'eventual' },
            });
            if (res.ok) {
                const n = parseInt((await res.text()).trim(), 10);
                if (Number.isFinite(n)) userCount = n;
            }
        } catch { /* keep the sampled count */ }

        // Global Administrator member count — needs RoleManagement.Read.Directory
        // or Directory.Read.All; null when not granted.
        let admins = null;
        try {
            const roles = await _graphJson('/directoryRoles?$select=id,displayName,roleTemplateId', token, safeFetch);
            const globalAdmin = (roles?.value || []).find(r => r.roleTemplateId === GLOBAL_ADMIN_TEMPLATE_ID);
            if (globalAdmin) {
                const members = await _graphJson(`/directoryRoles/${globalAdmin.id}/members?$select=id&$top=100`, token, safeFetch);
                admins = Array.isArray(members?.value) ? members.value.length : null;
            } else {
                admins = 0; // role never activated in this tenant
            }
        } catch { /* permission missing — stay null */ }

        // MFA-capable count — needs AuditLog.Read.All + Entra ID P1/P2;
        // null when the report is not accessible.
        let mfaCapable = null;
        try {
            const reg = await _graphJson('/reports/authenticationMethods/userRegistrationDetails?$top=500&$select=isMfaCapable', token, safeFetch);
            if (Array.isArray(reg?.value)) {
                mfaCapable = reg.value.filter(r => r.isMfaCapable).length;
            }
        } catch { /* licence or permission missing — stay null */ }

        return [{
            subject_id: 'summary',
            payload: {
                source: 'microsoft-entra',
                users: userCount,
                enabled,
                admins,
                dormant_90d: signInAvailable ? dormant : null,
                mfa_capable: mfaCapable,
                sample_size: sample.length,
                truncated: !!page?.['@odata.nextLink'],
            },
        }];
    },
};
