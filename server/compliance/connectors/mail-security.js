/**
 * Mail security probe (credential-less) — SPF / DMARC / DKIM presence for the
 * organisation's sending domain via public DNS. Evidence for information-
 * transfer and application-security controls (A.5.14, A.8.26): a domain
 * without SPF/DMARC lets anyone spoof the org's mail.
 *
 * DKIM caveat (honest): selectors are not discoverable; we probe a list of
 * common ones plus any the org configured. "Not found" therefore means "not
 * found under the probed selectors", never "absent" — the check downgrades to
 * warn, not fail, on DKIM alone.
 */

const dns = require('node:dns').promises;

const COMMON_DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 'mail', 's1'];

// Node's answers for "no TXT record here" (ENODATA) and "no such name"
// (NXDOMAIN, ENOTFOUND). Anything else (SERVFAIL, a timeout, a refused query)
// says nothing about the record.
const ABSENT = new Set(['ENODATA', 'ENOTFOUND']);

/**
 * TXT records of `name`. Strict (the default) throws when the lookup itself
 * failed, so a transient resolver error fails the sweep: the collector then
 * keeps the last snapshot and marks the connector row 'error', instead of
 * recording "SPF/DMARC absent" and raising a drift notice. The DKIM selector
 * probes are not strict: NXDOMAIN is the normal answer there, and DKIM alone
 * never fails the check.
 */
async function _txt(name, { strict = true } = {}) {
    try {
        const rows = await dns.resolveTxt(name);
        return rows.map(parts => parts.join('')).filter(Boolean);
    } catch (e) {
        if (!strict || ABSENT.has(e?.code)) return [];
        throw new Error(`DNS lookup for ${name} failed (${e?.code || 'error'})`);
    }
}

module.exports = {
    id: 'mail-security',
    titleKey: 'compliance.connector.mail_security.title',
    descKey: 'compliance.connector.mail_security.desc',
    coveredControls: ['A.5.14', 'A.8.26'],
    checks: ['ISO27001-A.5.14-mail-security'],
    credential: null,
    settingsHint: 'domain: "beeflow.nl", dkim_selectors: ["mandrill"]',

    async collect({ settings }) {
        const domain = String(settings?.domain || '').trim().toLowerCase();
        if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return [];

        const spfRecords = (await _txt(domain)).filter(r => r.toLowerCase().startsWith('v=spf1'));
        const dmarcRecords = (await _txt(`_dmarc.${domain}`)).filter(r => r.toLowerCase().startsWith('v=dmarc1'));
        // The p= tag itself, anchored to a tag boundary: a bare /p=/ also
        // matched the p= inside sp=none and read 'sp=none; p=reject' as 'none'.
        const dmarcPolicy = dmarcRecords.length
            ? (dmarcRecords[0].match(/(?:^|;)\s*p\s*=\s*([a-z]+)/i)?.[1] || 'none').toLowerCase()
            : null;

        const selectors = [...new Set([
            ...COMMON_DKIM_SELECTORS,
            ...(Array.isArray(settings?.dkim_selectors) ? settings.dkim_selectors.map(String) : []),
        ])];
        const dkimFound = [];
        for (const sel of selectors) {
            const rows = await _txt(`${sel}._domainkey.${domain}`, { strict: false });
            // A published key is a non-empty p= tag; an empty p= is a revoked
            // key (RFC 6376 section 3.6.1), not a DKIM key in use.
            if (rows.some(r => /(?:^|;)\s*p\s*=\s*[A-Za-z0-9+/]/.test(r))) dkimFound.push(sel);
        }

        return [{
            subject_id: domain,
            payload: {
                domain,
                spf: { present: spfRecords.length > 0, record: spfRecords[0] || null },
                dmarc: { present: dmarcRecords.length > 0, policy: dmarcPolicy },
                dkim: { probed_selectors: selectors.length, found_selectors: dkimFound },
            },
        }];
    },
};
