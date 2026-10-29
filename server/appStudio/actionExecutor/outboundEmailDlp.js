// @typecheck
const log = require('../../telemetry/log');
const { fallback } = require('../../utils/bestEffort');
const studioAppDataStore = require('../../stores/studioAppDataStore');

/**
 * Screen an outbound message against the org's privacy shield.
 *
 * Fail-OPEN by design: this is a hygiene layer over a user-authored reply, not
 * an authorization gate, and a scanner outage must not stop a support desk from
 * answering its customers. Blocking only happens when the org explicitly asked
 * for it AND the scan actually ran.
 */
async function screenOutboundEmail(app, { text, subject }) {
    try {
        const configStore = require('../../stores/configStore');
        const orgId = app.organizationId || null;
        if (!orgId) return { blocked: false, outcome: 'skipped_no_org' };

        const mode = await configStore.getConfig(`studio_app_email_dlp_${orgId}`).catch((e) => fallback('appStudio/actionExecutor/outboundEmailDlp:screenOutboundEmail', e, null));
        // Default is scan-and-log. An org opts in to blocking deliberately.
        const shouldBlock = mode === 'block';

        const dlpRunner = require('../../core/dlp/dlpRunner');
        if (typeof dlpRunner.scan !== 'function') return { blocked: false, outcome: 'unavailable' };

        const shield = await require('../../core/privacy/orgShield').resolveOrgShield(orgId);
        // Mail leaves the platform whatever the org's LLM scope says, so scan it as 'all'.
        const result = await dlpRunner.scan(/** @type {any} */ ({
            messages: [{ role: 'user', content: `${subject}\n\n${text}` }],
            orgShieldConfig: { ...shield, dlpScope: 'all' },
        }));
        if (result?.scanStatus !== 'ok') return { blocked: false, outcome: result?.scanStatus === 'failed' ? 'scan_failed' : 'skipped' };
        const hits = result.findings?.length || 0;
        if (!hits) return { blocked: false, outcome: 'clean' };
        return { blocked: shouldBlock, outcome: shouldBlock ? 'blocked' : 'flagged' };
    } catch (e) {
        log.warn(`[ActionExecutor] outbound DLP scan failed for ${app.id}: ${/** @type {Error} */ (e).message}`);
        return { blocked: false, outcome: 'scan_failed' };
    }
}

const decodeEntities = (v) => String(v)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');

/**
 * The parameter values in the query string and fragment of a web link or image
 * source. Scheme, host and path are left out on purpose (a plain link would only
 * feed false positives to a gate that refuses the send), but a value such as
 * `?email=jan@klant.nl&name=Jan%20de%20Vries` is personal data that leaves with
 * the mail. data: and cid: sources are inline content, not links, and skipped.
 */
function urlParameterValues(url) {
    if (!/^(?:https?:)?\/\//i.test(url)) return [];
    const hashAt = url.indexOf('#');
    const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
    const fragment = hashAt === -1 ? '' : url.slice(hashAt + 1);
    const queryAt = beforeHash.indexOf('?');
    const query = queryAt === -1 ? '' : beforeHash.slice(queryAt + 1);
    const values = [];
    // A fragment is an anchor unless it is shaped like parameters.
    for (const part of [query, fragment.includes('=') ? fragment : '']) {
        if (!part) continue;
        for (const [key, value] of new URLSearchParams(part)) {
            const v = (value || key).trim();
            if (v) values.push(v);
        }
    }
    return values;
}

/**
 * What an HTML mail carries in attributes that htmlToText drops, one value per
 * line, entities decoded: the target of a mailto:/tel: href with the scheme
 * stripped, title and alt text, and the query/fragment parameter values of
 * http(s) href and src URLs. Narrower than scanning the raw HTML on purpose: tag
 * names, colours and the host and path of plain web links would only feed false
 * positives to a gate that refuses the send.
 */
function htmlAttributeText(html) {
    if (!html) return '';
    const out = [];
    const attr = /\b(href|src|title|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let m;
    while ((m = attr.exec(String(html))) !== null) {
        const name = m[1].toLowerCase();
        const value = decodeEntities(m[2] !== undefined ? m[2] : m[3]).trim();
        if (name === 'href' || name === 'src') {
            const scheme = name === 'href' ? /^(mailto|tel):/i.exec(value) : null;
            if (!scheme) { out.push(...urlParameterValues(value)); continue; }
            let target = value.slice(scheme[0].length);
            try { target = decodeURIComponent(target); } catch (err) { fallback('appStudio/actionExecutor/emailStep:htmlAttributeText', err); /* keep as written */ }
            if (scheme[1].toLowerCase() === 'mailto') target = target.split('?')[0];
            if (target) out.push(target);
            continue;
        }
        if (value) out.push(value);
    }
    return out.join('\n');
}

/** The text handed to the outbound DLP scan: the body, plus attribute values for HTML. */
function outboundScanText({ format, textBody, htmlBody }) {
    if (format !== 'html') return textBody;
    const attrs = htmlAttributeText(htmlBody);
    return attrs ? `${textBody}\n${attrs}` : textBody;
}
/**
 * Append to the outbound-mail ledger.
 *
 * BOTH identities are recorded on purpose: with a lend grant, viewer A sends
 * through grantor B's mailbox, and an audit that only knows one of them cannot
 * answer "who sent this".
 */
async function logOutboundEmail(app, entry) {
    try {
        await studioAppDataStore.logEmailSend({
            appId: app.id,
            connectorId: entry.connectorId,
            viewerUserId: entry.viewerUserId,
            effectiveUserId: entry.effectiveUserId,
            // Masked: the ledger records that we mailed a customer, not a
            // re-readable copy of their address.
            toMasked: entry.to.map(maskEmail).join(', ').slice(0, 500),
            subject: String(entry.subject || '').slice(0, 300),
            providerMessageId: entry.providerMessageId || null,
            threadKey: entry.threadKey || null,
            dlpOutcome: entry.dlpOutcome || null,
        });
    } catch (e) {
        log.warn(`[ActionExecutor] outbound e-mail log failed for ${app.id}: ${e.message}`);
    }
}

function maskEmail(address) {
    const [local, domain] = String(address || '').split('@');
    if (!domain) return '***';
    const head = local.slice(0, 2);
    return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

module.exports = { screenOutboundEmail, htmlAttributeText, outboundScanText, logOutboundEmail };
