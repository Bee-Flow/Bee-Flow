import { makeCanUse, resolveStudioNav, STUDIO_APPS } from './studioApps';

/**
 * The two steps between "the registry" and "the rows a person sees", in one
 * place so the rail (StudioRail.jsx), the sidebar's Studio flyout
 * (Sidebar.jsx) and the Start screen (StudioStart.jsx) cannot answer the gate
 * question three different ways.
 *
 * Pure functions, not a hook, on purpose: each caller already holds the
 * context values from its own position in the tree (Sidebar reads them beside
 * a dozen other things; Studio's Start screen reads them in a lazy chunk), and
 * a hook here would either subscribe to those contexts a second time or force
 * the caller to hand them over anyway.
 */

/**
 * The ctx every `gate(ctx)` in the registry is called with.
 *
 * `lockReason` is deliberately NOT passed through while the entitlements are
 * still loading or their fetch failed: `can` answers false for everything in
 * both states, so lockReason would call each gated section 'ceiling' and a
 * licensed org would watch Apps / Webpages / Meeting notes / Solutions /
 * Skills flash "Available on a higher plan" on every page load. A row is only
 * locked once the answer is real; until then a failed gate hides the row, as
 * it always did.
 */
export function studioGateContext({
    user, hasLicenseFeature, hasPermission,
    can, lockReason, entitlementsLoading = false, entitlementsError = null,
}) {
    const answerIsReal = !entitlementsLoading && !entitlementsError && typeof lockReason === 'function';
    return {
        user,
        hasLicenseFeature,
        hasPermission,
        canUse: makeCanUse(user),
        can,
        lockReason: answerIsReal ? lockReason : () => null,
    };
}

/**
 * The nav rows for a gate context: every gate-passing section plus the ones
 * locked on a licence/capability (spread with `locked`), minus the sections
 * that carry their own top-level entrance.
 *
 * `hiddenFromNav` is filtered HERE rather than in resolveStudioNav because it
 * is a nav concern and the shell still has to route to those sections:
 * Approvals is one, and it stays fully renderable from its own sidebar row,
 * the notification bell and every e-mail deep link.
 */
export function studioNavSections(apps, ctx) {
    return resolveStudioNav(apps, ctx).filter((app) => !app.hiddenFromNav);
}

/**
 * De naam van één sectie.
 *
 * Twee soorten descriptors, één antwoord: een runtime-module draagt een
 * locale-bewuste `label(t, locale)`, een ingebouwde sectie een i18n-sleutel
 * met Engelse fallback. Hier omdat dezelfde drie regels al op vier plekken
 * stonden (rail, flyout, Start, en nu "Laatst bewerkt"), en een sectie die op
 * het ene scherm anders heet dan op het andere is precies de drift die dit
 * bestand moet voorkomen.
 */
export function studioSectionLabel(app, t, locale) {
    if (!app) return '';
    if (typeof app.label === 'function') return app.label(t, locale);
    if (!app.labelKey) return app.labelFallback || app.id || '';
    return app.labelFallback ? t(app.labelKey, app.labelFallback) : t(app.labelKey);
}

/**
 * De sectie die een SOORT beheert, uit het register — eerste treffer wint.
 *
 * Twee secties kunnen dezelfde `kind` dragen (Runs en Oplossingen), en de
 * eerste is de sectie die het ding zélf is. Hier omdat er inmiddels twee
 * afleidingen van precies deze wandeling waren: de kaart
 * (map/studioMap.js REGISTRY_BY_KIND) en de aandachtslijst
 * (attention/attentionLink.js SEGMENT_BY_KIND), allebei nieuw op dezelfde dag.
 * Twee kopieën van "welke sectie hoort bij dit soort" zijn twee antwoorden op
 * de vraag waar de knop "Laat zien" heen gaat.
 *
 * Alleen de INGEBOUWDE secties: een runtime-module draagt vandaag geen `kind`,
 * en STUDIO_APPS is de lijst die op elke build hetzelfde is.
 */
const APP_BY_KIND = (() => {
    const out = {};
    for (const app of STUDIO_APPS) {
        if (app?.kind && !out[app.kind]) out[app.kind] = app;
    }
    return out;
})();

/** Het registerrecord van een soort, of null. */
export function studioAppForKind(kind) {
    return (kind && APP_BY_KIND[kind]) || null;
}
