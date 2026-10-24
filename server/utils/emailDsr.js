// @typecheck
const { renderEmailFromTemplate } = require('./emailTemplates');
const { sendServiceEmail } = require('./emailTransport');

const DSR_TYPE_WORDS = {
    en: { access: 'access', rectification: 'rectification', deletion: 'erasure', portability: 'data portability', restriction: 'restriction of processing', objection: 'objection' },
    nl: { access: 'inzage', rectification: 'rectificatie', deletion: 'verwijdering', portability: 'overdraagbaarheid', restriction: 'beperking van de verwerking', objection: 'bezwaar' },
};

const DSR_STATUS_WORDS = {
    en: { fulfilled: 'fulfilled', rejected: 'rejected' },
    nl: { fulfilled: 'afgehandeld', rejected: 'afgewezen' },
};

function _dsrLang(locale) {
    const lang = typeof locale === 'string' ? locale.toLowerCase().split(/[-_]/)[0] : 'en';
    return lang === 'nl' ? 'nl' : 'en';
}

function _dsrDate(value, lang) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    try {
        return d.toLocaleDateString(lang === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch { return d.toISOString().slice(0, 10); }
}

/**
 * Built-in template for the locale, then the admin's per-locale override on
 * top (same precedence languageStore.getEffectiveEmailTemplate applies, plus
 * the locale default layer the DSR letters ship with).
 */
async function _resolveDsrTemplate(templateId, lang) {
    const { getDefaultEmailTemplate, EMAIL_TEMPLATE_FIELDS } = require('../i18n/defaults/emailTemplates');
    const base = getDefaultEmailTemplate(templateId, lang);
    if (!base) throw new Error(`Unknown email template '${templateId}'`);
    let override = null;
    try {
        const languageStore = require('../stores/languageStore');
        override = languageStore.getEmailTemplate ? await languageStore.getEmailTemplate(lang, templateId) : null;
    } catch { override = null; }
    if (!override) return base;
    const merged = { ...base };
    for (const f of EMAIL_TEMPLATE_FIELDS) {
        if (typeof override[f] === 'string' && override[f].trim()) merged[f] = override[f];
    }
    return merged;
}

function _dsrCommonVars({ requestId, requestType, orgName, dpoEmail }, lang) {
    return {
        requestId: String(requestId ?? ''),
        requestType: DSR_TYPE_WORDS[lang][String(requestType || '').toLowerCase()] || String(requestType || ''),
        orgName: String(orgName || 'the organisation'),
        dpoEmail: String(dpoEmail || ''),
    };
}

/**
 * Acknowledgement + identity link, sent right after a public-form submission.
 * @param {{ to: string, requestId: number|string, requestType: string, dueAt: string|Date,
 *   verifyUrl?: string, statusUrl?: string, orgName?: string, dpoEmail?: string, locale?: string }} opts
 */
async function sendDsrAckEmail({ to, requestId, requestType, dueAt, verifyUrl, statusUrl, orgName, dpoEmail, locale }) {
    if (!to) throw new Error('to is required');
    const lang = _dsrLang(locale);
    const tpl = await _resolveDsrTemplate('dsr_ack', lang);
    const vars = {
        ..._dsrCommonVars({ requestId, requestType, orgName, dpoEmail }, lang),
        dueDate: _dsrDate(dueAt, lang),
        statusUrl: String(statusUrl || ''),
        verifyUrl: verifyUrl || null,
    };
    if (!verifyUrl) tpl.ctaLabel = '';
    const { subject, html, text } = renderEmailFromTemplate(tpl, vars);
    return sendServiceEmail({ to, subject, text, html });
}

/**
 * Art. 12(3) extension notice — the subject must be told within the first
 * month, with the reason.
 * @param {{ to: string, requestId: number|string, requestType: string, extendedUntil: string|Date,
 *   reason: string, orgName?: string, dpoEmail?: string, locale?: string }} opts
 */
async function sendDsrExtensionEmail({ to, requestId, requestType, extendedUntil, reason, orgName, dpoEmail, locale }) {
    if (!to) throw new Error('to is required');
    const lang = _dsrLang(locale);
    const tpl = await _resolveDsrTemplate('dsr_extension', lang);
    tpl.ctaLabel = '';
    const vars = {
        ..._dsrCommonVars({ requestId, requestType, orgName, dpoEmail }, lang),
        extendedUntil: _dsrDate(extendedUntil, lang),
        reason: String(reason || '').slice(0, 1000),
    };
    const { subject, html, text } = renderEmailFromTemplate(tpl, vars);
    return sendServiceEmail({ to, subject, text, html });
}

/**
 * The outcome letter. `resultSummary` is the admin's text for the subject —
 * the data itself travels by the channel the admin chose, never in this mail.
 * @param {{ to: string, requestId: number|string, requestType: string, status: 'fulfilled'|'rejected',
 *   resultSummary?: string, orgName?: string, dpoEmail?: string, locale?: string }} opts
 */
async function sendDsrResultEmail({ to, requestId, requestType, status, resultSummary, orgName, dpoEmail, locale }) {
    if (!to) throw new Error('to is required');
    const lang = _dsrLang(locale);
    const tpl = await _resolveDsrTemplate('dsr_result', lang);
    tpl.ctaLabel = '';
    const st = status === 'rejected' ? 'rejected' : 'fulfilled';
    const vars = {
        ..._dsrCommonVars({ requestId, requestType, orgName, dpoEmail }, lang),
        status: DSR_STATUS_WORDS[lang][st],
        resultSummary: String(resultSummary || '').slice(0, 4000),
    };
    const { subject, html, text } = renderEmailFromTemplate(tpl, vars);
    return sendServiceEmail({ to, subject, text, html });
}

module.exports = { sendDsrAckEmail, sendDsrExtensionEmail, sendDsrResultEmail };
