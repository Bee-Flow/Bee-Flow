/**
 * Nextcloud serverinfo connector — workplace-software evidence for
 * A.8.19/A.8.8: which server version is running and whether app updates are
 * pending, via the built-in serverinfo OCS API
 * (GET {base_url}/ocs/v2.php/apps/serverinfo/api/v1/info?format=json,
 * header OCS-APIRequest: true, admin Basic auth).
 *
 * Credential (vault provider 'nextcloud', kind basic): an ADMIN account plus
 * an app password (personal Settings → Security → Devices & sessions —
 * never the real login password). Secret read defensively:
 * { username, password } or { user, appPassword }.
 * Settings: { base_url: 'https://cloud.acme.nl' }.
 *
 * Honest limits: a latest-release lookup is out of scope, so
 * version_outdated_hint stays null — the evidence value is "the running
 * version is recorded and pinned in the hash chain", not "the version is
 * current". apps_updates_available comes straight from serverinfo when the
 * instance exposes it.
 */

module.exports = {
    id: 'nextcloud',
    titleKey: 'compliance.connector.nextcloud.title',
    descKey: 'compliance.connector.nextcloud.desc',
    coveredControls: ['A.8.19', 'A.8.8'],
    checks: ['ISO27001-A.8.19-workplace-software'],
    credential: { provider: 'nextcloud', kinds: ['basic'] },
    settingsHint: 'base_url: "https://cloud.acme.nl"',

    async collect({ secret, settings, safeFetch }) {
        const baseUrl = String(settings?.base_url || settings?.baseUrl || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(baseUrl)) {
            throw new Error('nextcloud settings need base_url (https://…)');
        }
        const username = secret?.username || secret?.user;
        const password = secret?.password || secret?.appPassword || secret?.app_password;
        if (!username || !password) {
            throw new Error('nextcloud secret needs { username, password } (admin + app password)');
        }

        const res = await safeFetch(`${baseUrl}/ocs/v2.php/apps/serverinfo/api/v1/info?format=json`, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
                'OCS-APIRequest': 'true',
                'Accept': 'application/json',
            },
        });
        if (!res.ok) {
            throw new Error(`Nextcloud serverinfo failed (${res.status}) — check base_url and the admin app password`);
        }
        const data = await res.json().catch(() => null);
        const nc = data?.ocs?.data?.nextcloud;
        if (!nc) throw new Error('Nextcloud serverinfo returned an unexpected shape');

        const version = nc.system?.version ? String(nc.system.version) : null;
        const appsUpdates = Number(nc.system?.apps?.num_updates_available);
        const users = Number(nc.storage?.num_users);

        return [{
            subject_id: 'summary',
            payload: {
                source: 'nextcloud',
                version,
                apps_updates_available: Number.isFinite(appsUpdates) ? appsUpdates : null,
                users: Number.isFinite(users) ? users : null,
                version_outdated_hint: null,
            },
        }];
    },
};
