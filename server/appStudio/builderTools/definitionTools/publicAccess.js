/**
 * App Studio builder tools — the app's PUBLIC surface (app_set_public_access):
 * the screens an anonymous visitor may open at /p/<token>, and the loud echo
 * about the two states that are invisible in the definition (the app must be
 * published; the reserved `public` role is denied by default on every table).
 */

'use strict';

const ops = require('../../definitionOps');
const { PUBLIC_ROLE_KEY } = require('../../dataModel');
const { adoptCanonical } = require('../shared');

/**
 * Open (or close) the app's PUBLIC surface — the screens an anonymous visitor
 * may open at /p/<token>.
 *
 * The echo is deliberately loud. Two things about this feature are invisible in
 * the definition and both silently produce a page that "works" while doing the
 * wrong thing: the app must be PUBLISHED (anonymous visitors are served the
 * frozen published copy, so an unpublished app 404s), and the reserved `public`
 * role is DENIED BY DEFAULT on every table, so a form with no explicit grant
 * submits into a 403. Neither is an error here — both are states the builder
 * has to be told about.
 */
function applySetPublicAccess(draftWrap, args) {
    if (!Object.hasOwn(args || {}, 'publicAccess')) {
        return { error: 'Pass `publicAccess` as { entryScreenId, screenIds?, title?, theme?, design? } — or null to close the public page.' };
    }
    const requested = args.publicAccess;
    if (requested !== null && (typeof requested !== 'object' || Array.isArray(requested))) {
        return { error: 'publicAccess must be an object { entryScreenId, screenIds?, title?, theme?, design? } or null.' };
    }

    const next = ops.setPublicAccess(draftWrap.def, requested);
    const result = adoptCanonical(draftWrap, next, {});
    // Read AFTER adoption — the canonicalizer resolves screen ids and may drop
    // the whole block (see every other echo in this file).
    const applied = draftWrap.def.publicAccess || null;
    result.publicAccess = applied;

    if (requested && !applied) {
        result._hints = [
            ...(result._hints || []),
            'publicAccess was dropped by the canonicalizer — entryScreenId did not resolve to a screen in this app.',
        ];
        return result;
    }
    if (!applied) return result;

    const hints = [];
    const model = draftWrap.dataModel && typeof draftWrap.dataModel === 'object' ? draftWrap.dataModel : null;
    const tables = Array.isArray(model?.tables) ? model.tables : [];
    const granted = tables.filter((t) => {
        const roles = t && t.access && typeof t.access.roles === 'object' ? t.access.roles : {};
        const entry = roles[PUBLIC_ROLE_KEY];
        return entry && typeof entry === 'object' && Object.keys(entry).length > 0;
    });
    if (tables.length && !granted.length) {
        hints.push(`No table grants the reserved role "${PUBLIC_ROLE_KEY}" yet, so a visitor can neither read nor write anything — the form will submit into a 403. Grant it per table with app_upsert_table access.roles.${PUBLIC_ROLE_KEY}, e.g. {create:true, read:"own"}.`);
    } else if (granted.length) {
        hints.push(`Tables open to anonymous visitors: ${granted.map((t) => t.key || t.id).join(', ')}. Every other table denies them by default.`);
    }
    hints.push('Publish the app, then mint the URL: POST /api/studio-apps/<id>/public-pages (owner-only) returns /p/<token>. Anonymous visitors always get the PUBLISHED definition, so re-publish after changing these screens.');
    result._hints = [...(result._hints || []), ...hints];
    return result;
}

module.exports = { applySetPublicAccess };
