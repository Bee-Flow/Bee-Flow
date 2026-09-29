/**
 * YouTrack connector — change/work-tracking evidence for A.8.32: recent
 * issue activity in the designated operations project shows that changes
 * run through tickets rather than ad hoc.
 *
 * Credential (vault provider 'youtrack', kind bearer): secret { token } — a
 * permanent token (Profile → Account Security → Tokens). Read access to the
 * configured project suffices.
 * Settings: { base_url: 'https://acme.youtrack.cloud', project: 'OPS' }.
 *
 * Endpoint: GET {base_url}/api/issues?query=…&fields=id,resolved&$top=100
 * with a concrete 30-day date range (relative-date query syntax is avoided
 * on purpose). Depth: issue ids + resolved flags, reduced to two counters —
 * no summaries, reporters or other issue content in the snapshot.
 */

module.exports = {
    id: 'youtrack',
    titleKey: 'compliance.connector.youtrack.title',
    descKey: 'compliance.connector.youtrack.desc',
    coveredControls: ['A.8.32'],
    checks: ['ISO27001-A.8.32-ticketed-changes'],
    credential: { provider: 'youtrack', kinds: ['bearer'] },
    settingsHint: 'base_url: "https://acme.youtrack.cloud", project: "OPS"',

    async collect({ secret, settings, safeFetch }) {
        const token = secret?.token || secret?.apiKey || secret?.api_key;
        if (!token) throw new Error('youtrack secret needs { token } (permanent token)');
        const baseUrl = String(settings?.base_url || settings?.baseUrl || '').trim().replace(/\/+$/, '');
        const project = String(settings?.project || '').trim();
        if (!/^https?:\/\//i.test(baseUrl) || !project) {
            throw new Error('youtrack settings need base_url and project');
        }

        const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const projectTerm = /\s/.test(project) ? `{${project}}` : project;
        const params = new URLSearchParams({
            query: `project: ${projectTerm} updated: ${since} .. Today`,
            fields: 'id,resolved',
            '$top': '100',
        });

        const res = await safeFetch(`${baseUrl}/api/issues?${params}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`YouTrack issues query failed (${res.status}): ${body.slice(0, 150)}`);
        }
        const issues = await res.json().catch(() => null);
        if (!Array.isArray(issues)) throw new Error('YouTrack issues query returned an unexpected shape');

        return [{
            subject_id: project,
            payload: {
                source: 'youtrack',
                project,
                window_days: 30,
                recent_issues: issues.length,
                resolved_recent: issues.filter(i => i.resolved != null).length,
            },
        }];
    },
};
