/**
 * EU AI Act Art. 50(2) — content marking for AI-generated documents.
 *
 * resolveMarking(orgId, { automationId, aiStepIds, provider }) answers "does
 * this org mark AI output, and with which footer" for one render:
 *
 *   null                                       marking is off for the org
 *   { enabled:true, org_name, provider, generated_at, automation_id,
 *     ai_step_ids, footer_text, locale }        what documentRenderer prints and
 *                                              writes into the file metadata
 *
 * The footer text is the org's own override (compliance_settings.
 * ai_content_marking_footer, `{org}` substituted) or the i18n default
 * `compliance.marking_footer` — "Generated with AI — {org}" / "Gegenereerd met
 * AI — {org}" — resolved through the same GUI-strings loader the rest of the
 * server uses (languageStore.getEffectiveGUIStrings), with a hardcoded EN/NL
 * fallback so a render never fails on a missing dictionary key.
 *
 * Settings + org name are memoised for 60 s per org: a routine that renders
 * fifty letters in a loop should not read compliance_settings fifty times.
 * `invalidate(orgId)` drops the memo (the settings route calls it when the
 * flag or the footer changes; the CONTENT_MARKING_CHANGED event is the other
 * hook).
 */

const complianceStore = require('../stores/complianceStore');

const MEMO_MS = Number(process.env.COMPLIANCE_MARKING_MEMO_MS) > 0 ? Number(process.env.COMPLIANCE_MARKING_MEMO_MS) : 60_000;
const FOOTER_KEY = 'compliance.marking_footer';
const FOOTER_DEFAULTS = Object.freeze({
    en: 'Generated with AI — {org}',
    nl: 'Gegenereerd met AI — {org}',
});
const SUBJECT_LINE = 'AI-generated content — EU AI Act Art. 50(2)';
const MAX_FOOTER = 300;

const _memo = new Map(); // orgId → { at, value: { settings, orgName, locale } }

function _now() { return Date.now(); }

async function _orgName(orgId) {
    try {
        const userStore = require('../stores/userStore');
        const org = typeof userStore.getOrganization === 'function' ? await userStore.getOrganization(orgId) : null;
        const name = org && typeof org.name === 'string' ? org.name.trim() : '';
        return name || String(orgId);
    } catch {
        return String(orgId);
    }
}

async function _defaultLocale() {
    try {
        const languageStore = require('../stores/languageStore');
        const locales = await languageStore.getAvailableLocales();
        const def = Array.isArray(locales) ? locales.find(l => l && l.isDefault) : null;
        const code = def && typeof def.code === 'string' ? def.code.toLowerCase().slice(0, 2) : 'en';
        return code || 'en';
    } catch {
        return 'en';
    }
}

async function _dictionaryFooter(locale) {
    try {
        const languageStore = require('../stores/languageStore');
        const strings = await languageStore.getEffectiveGUIStrings(locale);
        const v = strings && strings[FOOTER_KEY];
        if (typeof v === 'string' && v.trim()) return v;
    } catch { /* dictionary unavailable → fallback below */ }
    return FOOTER_DEFAULTS[locale] || FOOTER_DEFAULTS.en;
}

async function _context(orgId) {
    const hit = _memo.get(orgId);
    if (hit && _now() - hit.at < MEMO_MS) return hit.value;
    let settings = null;
    try { settings = await complianceStore.getSettings(orgId); } catch { settings = null; }
    const enabled = !!(settings && settings.ai_content_marking_enabled);
    const value = { settings: settings || {}, enabled, orgName: null, locale: null, footerTemplate: null };
    if (enabled) {
        // Only an org that marks pays for the extra reads.
        value.orgName = await _orgName(orgId);
        value.locale = await _defaultLocale();
        const override = typeof value.settings.ai_content_marking_footer === 'string' ? value.settings.ai_content_marking_footer.trim() : '';
        value.footerTemplate = override || await _dictionaryFooter(value.locale);
    }
    _memo.set(orgId, { at: _now(), value });
    return value;
}

function _render(template, orgName) {
    const text = String(template || '').replace(/\{\s*org\s*\}/g, orgName || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, MAX_FOOTER);
}

/**
 * @param {string} orgId
 * @param {{ automationId?: string|null, aiStepIds?: string[], provider?: string|null, now?: Date }} [opts]
 * @returns {Promise<null|{enabled:true, org_name:string, provider:string|null, generated_at:string, automation_id:string|null, ai_step_ids:string[], footer_text:string, locale:string}>}
 */
async function resolveMarking(orgId, { automationId = null, aiStepIds = [], provider = null, now = null } = {}) {
    if (!orgId) return null;
    const ctx = await _context(orgId);
    if (!ctx.enabled) return null;
    const generatedAt = (now instanceof Date ? now : new Date()).toISOString();
    return {
        enabled: true,
        org_name: ctx.orgName,
        provider: provider ? String(provider).slice(0, 80) : null,
        generated_at: generatedAt,
        automation_id: automationId ? String(automationId) : null,
        ai_step_ids: Array.isArray(aiStepIds) ? aiStepIds.filter(Boolean).map(String) : [],
        footer_text: _render(ctx.footerTemplate, ctx.orgName),
        locale: ctx.locale || 'en',
    };
}

/** Drop the memo for one org (or every org). */
function invalidate(orgId) {
    if (orgId === undefined) _memo.clear();
    else _memo.delete(orgId);
}

/** The PDF keyword list documentRenderer writes (pdf-lib setKeywords / pdfkit Info.Keywords). */
function keywordsFor(marking) {
    if (!marking) return [];
    return [
        'AIGenerated=true',
        `AIProvider=${marking.provider || 'unknown'}`,
        `GeneratedAt=${marking.generated_at}`,
        `BeeFlowAutomation=${marking.automation_id || ''}`,
    ];
}

module.exports = {
    resolveMarking,
    invalidate,
    keywordsFor,
    FOOTER_KEY,
    FOOTER_DEFAULTS,
    SUBJECT_LINE,
    MEMO_MS,
};
