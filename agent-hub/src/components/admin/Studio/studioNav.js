import { firstOpenStudioSection, makeCanUse, resolveStudioNav, STUDIO_APPS, studioPermissionHeld } from './studioApps';
import { isStudioStart } from './studioStart';

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
 * Who had Studio before sections opened per permission: an admin, or someone
 * whose role builds agents or skills. Builders keep exactly the Studio they
 * had — every section their gates pass, the locked signposts, Documents and
 * the Start screen — so this is kept as its own answer rather than folded
 * into the section count below.
 */
export function isStudioBuilder(user) {
    const perms = user?.permissions || [];
    return !!user?.isAdmin || perms.includes('all')
        || perms.includes('manage_agents') || perms.includes('manage_skills')
        || user?.orgRole === 'admin' || user?.orgRole === 'org_admin';
}

/**
 * The sections that earn someone a Studio entry: open (a locked row is a
 * signpost, not a door) and not reachable from a sidebar row of their own
 * (Documents, `topLevelEntrance`). A member whose role opens Meeting Notes
 * gets Studio for it; a member whose role opens nothing in Studio does not get
 * a Studio holding only Documents.
 */
export function studioEntrySections(sections) {
    return (sections || []).filter((s) => s && !s.locked && !s.topLevelEntrance);
}

/**
 * Does this person get Studio at all (the sidebar row, the rail)? A builder
 * as before, and now also anyone with at least one section of their own.
 * `sections` is the studioNavSections output — every gate already applied,
 * so a section counts only when its licence, programme AND permission pass.
 * Simple Mode and phone width are the caller's (Sidebar.jsx).
 */
export function canSeeStudio({ user, sections }) {
    return isStudioBuilder(user) || studioEntrySections(sections).length > 0;
}

/**
 * Where the Studio row lands. A builder: the first open section, as before.
 * Anyone else: the first section that earned them Studio — never Documents,
 * which they have a row for, and never a fallback they may not open (null).
 */
export function studioLanding({ user, sections, fallback = STUDIO_APPS[0] }) {
    return isStudioBuilder(user)
        ? firstOpenStudioSection(sections, fallback)
        : firstOpenStudioSection(studioEntrySections(sections), null);
}

/**
 * May the shell render `section` for this person? The sidebar and the rail
 * only LIST what passes; this is the same answer for a direct URL, so a
 * section that is hidden from someone cannot be reached by typing its address.
 *
 *   - Start is a builder's dashboard (the map, the makers figure, the "New"
 *     menu over every kind): someone who has Studio for one or two sections
 *     lands on their first section instead.
 *   - A section whose PERMISSION leg fails is refused. Only that leg: a
 *     licence or capability miss still renders, and the section's own
 *     upgrade panel or the server's 403 says why — exactly as before, and
 *     without bouncing anyone while the entitlements are still loading.
 *   - `hiddenFromNav` sections (Approvals) are not refused here: they have
 *     their own entrance, e-mail and bell deep links land on them, and the
 *     section decides itself what an assignee may see.
 *   - An unknown id or a runtime module (no `permission`) renders as before.
 *
 * Returns { allowed, redirectTo } — redirectTo is the urlSegment of the first
 * section this person may open, or null when there is none (the shell then
 * shows its no-access state).
 */
export function studioSectionAccess({ section, apps, user, hasPermission, sections }) {
    const allowed = { allowed: true, redirectTo: null };
    const refuse = () => {
        const to = studioLanding({ user, sections, fallback: null });
        return { allowed: false, redirectTo: to ? to.urlSegment : null };
    };
    if (isStudioStart(section)) return isStudioBuilder(user) ? allowed : refuse();
    const app = (apps || []).find((a) => a?.id === section);
    if (!app || app.hiddenFromNav) return allowed;
    return studioPermissionHeld(app, hasPermission) ? allowed : refuse();
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
