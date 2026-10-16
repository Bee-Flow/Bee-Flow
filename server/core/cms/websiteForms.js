// @typecheck
/**
 * Website forms: the pure half of the CMS `form` block (routes/cmsForms.js is
 * the HTTP half).
 *
 * A `form` block collects a few answers from an anonymous visitor and hands
 * them to a Bee Flow automation of the same install, so a demo request or a
 * newsletter sign-up never leaves it. Nothing here does I/O.
 *
 * What the visitor's browser may influence is deliberately tiny: it names a
 * block id and sends answers. Which automation runs, which fields exist and
 * whether consent is needed all come from the PUBLISHED block, read here.
 */

'use strict';

const { normalizeFields, coerceSubmission } = require('../../automation/formTriggerContract');
const { definitionForRun, triggersOf } = require('../automationRunner/definitionForRun');

/** The field types a website form may declare (a subset of the automation form's). */
const WEBSITE_FORM_FIELD_TYPES = Object.freeze(['text', 'email', 'textarea', 'select', 'checkbox']);
/** Fields per form: a lead form is short, and every extra field is more data to hold. */
const MAX_WEBSITE_FORM_FIELDS = 20;
const BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_CONSENT_TEXT = 500;

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The fields a block declares, in the shape the automation forms validate
 * against. The block's `id` is the field name (`trigger.output.<id>` in the
 * automation); a type outside the website subset is dropped, not coerced.
 * @param {Record<string, any> | null | undefined} content a form block's content
 */
function declaredFields(content) {
    const raw = Array.isArray(content?.fields) ? content.fields : [];
    const allowed = raw
        .filter((f) => isPlainObject(f) && WEBSITE_FORM_FIELD_TYPES.includes(f.type))
        .slice(0, MAX_WEBSITE_FORM_FIELDS)
        .map((f) => ({ name: f.id, type: f.type, label: f.label, placeholder: f.placeholder, required: !!f.required, options: f.options }));
    return normalizeFields({ fields: allowed });
}

/**
 * The consent the block asks for. When enabled, the visitor must tick it, and
 * the exact wording they saw rides with the submission as the audit trail.
 * @param {Record<string, any> | null | undefined} content
 * @returns {{ required: boolean, text: string }}
 */
function consentOf(content) {
    const c = isPlainObject(content?.consent) ? content.consent : {};
    const text = typeof c.text === 'string' ? c.text.trim().slice(0, MAX_CONSENT_TEXT) : '';
    return { required: c.enabled === true && text !== '', text };
}

/**
 * The consent wording a visitor saw: the override for their locale when the
 * site has one (the text is translatable), else the site's own wording.
 * Returns the locale it came from, so the record says which text it holds.
 * @param {Record<string, any> | null | undefined} snapshot
 * @param {{ block: Record<string, any>, pageId: string }} found
 * @param {unknown} locale what the visitor's page said it was showing
 * @returns {{ required: boolean, text: string, locale: string }}
 */
function consentFor(snapshot, found, locale) {
    const base = consentOf(found.block.content);
    const loc = typeof locale === 'string' && /^[a-z]{2,3}$/.test(locale) ? locale : null;
    const overrides = snapshot?.pageLocaleOverrides?.[found.pageId]?.[loc || ''];
    const text = overrides?.blocks?.[found.block.id]?.content?.consent?.text;
    if (loc && typeof text === 'string' && text.trim()) {
        return { required: base.required, text: text.trim().slice(0, MAX_CONSENT_TEXT), locale: loc };
    }
    return { ...base, locale: 'default' };
}

/**
 * Every `form` block of a set of page documents (the draft), with the
 * automation each names: what an admin needs to see which blocks target which
 * automation.
 * @param {{ id: string, title?: string, blocks?: unknown }[]} pages
 * @returns {{ blockId: string, pageId: string, pageTitle: string, automationId: string }[]}
 */
function formBlocksOf(pages) {
    /** @type {{ blockId: string, pageId: string, pageTitle: string, automationId: string }[]} */
    const out = [];
    for (const page of pages) {
        const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
        for (const b of blocks) {
            if (!isPlainObject(b) || b.type !== 'form' || typeof b.id !== 'string') continue;
            const automationId = typeof b.content?.automationId === 'string' ? b.content.automationId.trim() : '';
            out.push({ blockId: b.id, pageId: page.id, pageTitle: page.title || '', automationId });
        }
    }
    return out;
}

/**
 * A published, enabled `form` block by id, anywhere on any page of a
 * published snapshot. Draft content never answers: only what is live.
 * @param {Record<string, any> | null | undefined} snapshot cmsStore.getPublishedSnapshot()
 * @param {string} blockId
 * @returns {{ block: Record<string, any>, pageId: string } | null}
 */
function findFormBlock(snapshot, blockId) {
    if (!BLOCK_ID_RE.test(String(blockId))) return null;
    const pages = isPlainObject(snapshot?.pages) ? snapshot.pages : {};
    for (const [pageId, page] of Object.entries(pages)) {
        const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
        const block = blocks.find((b) => isPlainObject(b) && b.type === 'form' && b.id === blockId);
        if (block && block.enabled !== false) return { block, pageId };
    }
    return null;
}

/**
 * The webhook trigger a website form enters an automation through: the first
 * `webhook` trigger of its LIVE definition (what runs, not the working copy).
 * A website form is an inbound call, so the automation declares that it
 * expects one; an automation without a webhook trigger cannot be a target.
 * @param {Record<string, any>} automation
 * @returns {string | null} the trigger step id
 */
function webhookTriggerId(automation) {
    const { definition } = definitionForRun(automation, { mode: 'live' });
    const hit = triggersOf(definition).find((t) => t && t.kind === 'webhook' && typeof t.id === 'string' && t.id);
    return hit ? hit.id : null;
}

/**
 * Validate a submission against a block's declared fields.
 * Only declared fields are read, never the body's own keys.
 * @param {Record<string, any> | null | undefined} content
 * @param {unknown} body
 * @returns {{ values: Record<string, any>, errors: { field: string, message: string }[] }}
 */
function validateSubmission(content, body) {
    const fields = declaredFields(content);
    const { values, errors } = coerceSubmission(fields, body);
    const consent = consentOf(content);
    const given = isPlainObject(body) && body.consent === true;
    /** @type {{ field: string, message: string }[]} */
    const all = [...errors];
    if (consent.required && !given) all.push({ field: 'consent', message: 'Please accept the consent statement.' });
    return { values: { ...values }, errors: all };
}

module.exports = {
    WEBSITE_FORM_FIELD_TYPES,
    MAX_WEBSITE_FORM_FIELDS,
    BLOCK_ID_RE,
    declaredFields,
    consentOf,
    consentFor,
    formBlocksOf,
    findFormBlock,
    webhookTriggerId,
    validateSubmission,
};
