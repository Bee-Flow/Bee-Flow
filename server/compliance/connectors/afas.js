/**
 * AFAS Profit connector — HR-population evidence for the employment
 * controls (A.6.1/A.6.5): the GetConnector the org designates as its
 * employee feed exists and returns rows, so joiner/leaver processing and
 * access reviews have an authoritative source.
 *
 * Credential (vault provider 'afas', kind api_key): secret { token } — the
 * AFAS AppConnector token XML
 * (<token><version>1</version><data>…</data></token>). AFAS expects
 * 'Authorization: AfasToken <base64(tokenXml)>'; a value that does not look
 * like XML is assumed to be pre-encoded and passed through unchanged.
 *
 * Settings: { base_url: 'https://12345.rest.afas.online/ProfitRestServices',
 *             connector: 'Profit_Employees' }.
 * Orgs define their own GetConnectors, so rows are treated generically: the
 * snapshot stores the row COUNT plus the field NAMES of the first row —
 * never field values, so no employee data lands in the evidence chain.
 */

// One page of rows: enough to show the feed has a population, never a mirror
// of the employee list. A full page means there may be more (`truncated`).
const PAGE_SIZE = 100;

module.exports = {
    id: 'afas',
    titleKey: 'compliance.connector.afas.title',
    descKey: 'compliance.connector.afas.desc',
    coveredControls: ['A.6.1', 'A.6.5'],
    checks: ['ISO27001-A.6.5-offboarding-feed'],
    credential: { provider: 'afas', kinds: ['api_key'] },
    settingsHint: 'base_url: "https://12345.rest.afas.online/ProfitRestServices", connector: "Profit_Employees"',

    async collect({ secret, settings, safeFetch }) {
        const token = secret?.token || secret?.apiKey || secret?.api_key;
        if (!token) throw new Error('afas secret needs { token } (AppConnector token XML)');
        const baseUrl = String(settings?.base_url || settings?.baseUrl || '').trim().replace(/\/+$/, '');
        const connectorName = String(settings?.connector || '').trim();
        if (!/^https?:\/\//i.test(baseUrl) || !connectorName) {
            throw new Error('afas settings need base_url and connector (GetConnector name)');
        }

        const raw = String(token).trim();
        const encoded = raw.startsWith('<') ? Buffer.from(raw).toString('base64') : raw;

        const res = await safeFetch(`${baseUrl}/connectors/${encodeURIComponent(connectorName)}?skip=0&take=${PAGE_SIZE}`, {
            headers: { 'Authorization': `AfasToken ${encoded}`, 'Accept': 'application/json' },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`AFAS GetConnector "${connectorName}" failed (${res.status}): ${body.slice(0, 150)}`);
        }
        const data = await res.json().catch(() => null);
        if (!data || !Array.isArray(data.rows)) {
            throw new Error(`AFAS GetConnector "${connectorName}" returned an unexpected shape`);
        }

        return [{
            subject_id: connectorName,
            payload: {
                source: 'afas',
                connector: connectorName,
                rows: data.rows.length,
                truncated: data.rows.length >= PAGE_SIZE,
                fields: data.rows.length ? Object.keys(data.rows[0]).slice(0, 40) : [],
                fetched: true,
            },
        }];
    },
};
