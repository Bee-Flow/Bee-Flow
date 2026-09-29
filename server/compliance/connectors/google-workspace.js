/**
 * Google Workspace directory connector — identity-population evidence for the
 * access-management controls (A.5.16/A.5.18/A.8.2): how many accounts exist,
 * how many are enrolled in 2-Step Verification, how many hold admin rights,
 * and how many look dormant.
 *
 * Credential (vault provider 'google-workspace', kind oauth2_cc). Two secret
 * shapes are accepted, read defensively:
 *   1. Service account with domain-wide delegation (recommended — unattended):
 *      { client_email, private_key, admin_subject }
 *      client_email/private_key come from the service-account JSON key;
 *      admin_subject is the super-admin the service account impersonates.
 *      Setup: create a service account, authorise its client id for
 *      domain-wide delegation in the Admin console (Security → Access and
 *      data control → API controls) with the scope below, then link the
 *      three fields here. The connector signs the RS256 JWT itself (plain
 *      node:crypto, no library) and exchanges it at
 *      https://oauth2.googleapis.com/token.
 *   2. { access_token } — a pre-obtained OAuth access token with the same
 *      scope (simple path; the org is responsible for refreshing it).
 *
 * Scope required: https://www.googleapis.com/auth/admin.directory.user.readonly
 * Settings: { customer: 'my_customer' } (default) or { domain: 'acme.nl' }.
 *
 * Depth: ONE Admin SDK users page (max 500), reduced to aggregate counts —
 * no names or e-mail addresses ever land in the snapshot. `truncated: true`
 * flags orgs above 500 users (counts are then a first-page sample).
 */

const crypto = require('node:crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';
const USERS_URL = 'https://admin.googleapis.com/admin/directory/v1/users';
const DORMANT_MS = 90 * 86400000;

function _b64url(value) {
    return Buffer.from(value).toString('base64url');
}

async function _serviceAccountToken({ clientEmail, privateKey, adminSubject }, safeFetch) {
    const now = Math.floor(Date.now() / 1000);
    const header = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = _b64url(JSON.stringify({
        iss: clientEmail,
        sub: adminSubject,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600,
    }));
    const unsigned = `${header}.${claims}`;
    // Keys pasted from JSON often carry literal \n sequences — normalize.
    const pem = String(privateKey).replace(/\\n/g, '\n');
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(pem, 'base64url');
    const res = await safeFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: `${unsigned}.${signature}`,
        }).toString(),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Google token exchange failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data.access_token) throw new Error('Google token exchange returned no access_token');
    return data.access_token;
}

module.exports = {
    id: 'google-workspace',
    titleKey: 'compliance.connector.google_workspace.title',
    descKey: 'compliance.connector.google_workspace.desc',
    coveredControls: ['A.5.16', 'A.5.18', 'A.8.2'],
    checks: ['ISO27001-A.5.16-identity-hygiene'],
    credential: { provider: 'google-workspace', kinds: ['oauth2_cc'] },
    settingsHint: 'customer: "my_customer" (default) or domain: "acme.nl"',

    async collect({ secret, settings, safeFetch }) {
        let token = secret?.access_token || null;
        if (!token) {
            const clientEmail = secret?.client_email || secret?.clientEmail;
            const privateKey = secret?.private_key || secret?.privateKey;
            const adminSubject = secret?.admin_subject || secret?.adminSubject || secret?.subject;
            if (!clientEmail || !privateKey || !adminSubject) {
                throw new Error('google-workspace secret needs { access_token } or { client_email, private_key, admin_subject }');
            }
            token = await _serviceAccountToken({ clientEmail, privateKey, adminSubject }, safeFetch);
        }

        const params = new URLSearchParams({
            maxResults: '500',
            fields: 'nextPageToken,users(isEnrolledIn2Sv,isAdmin,isDelegatedAdmin,lastLoginTime,suspended)',
        });
        const domain = String(settings?.domain || '').trim().toLowerCase();
        if (domain) params.set('domain', domain);
        else params.set('customer', String(settings?.customer || 'my_customer').trim() || 'my_customer');

        const res = await safeFetch(`${USERS_URL}?${params}`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`Google Directory users list failed (${res.status}): ${body.slice(0, 200)}`);
        }
        const data = await res.json();
        const users = Array.isArray(data.users) ? data.users : [];
        const cutoff = Date.now() - DORMANT_MS;
        let mfaEnrolled = 0;
        let admins = 0;
        let dormant = 0;
        let suspended = 0;
        for (const u of users) {
            if (u.suspended) { suspended++; continue; }
            if (u.isEnrolledIn2Sv) mfaEnrolled++;
            if (u.isAdmin || u.isDelegatedAdmin) admins++;
            // Never-logged-in accounts report the epoch — Date.parse handles both.
            const lastLogin = u.lastLoginTime ? Date.parse(u.lastLoginTime) : NaN;
            if (!Number.isFinite(lastLogin) || lastLogin < cutoff) dormant++;
        }
        return [{
            subject_id: 'summary',
            payload: {
                source: 'google-workspace',
                users: users.length,
                suspended,
                // Counted over non-suspended accounts:
                mfa_enrolled: mfaEnrolled,
                admins,
                dormant_90d: dormant,
                truncated: !!data.nextPageToken,
            },
        }];
    },
};
