/**
 * App Studio validator — the definition-level design/nav and public-access
 * checks of validateAppDefinition. A leaf module (specs, theme and shared
 * helpers only), so it stays out of the validator's import cycle.
 */

'use strict';

const { DESIGN_SPEC, NAV_STYLES, MAX_NAV_GROUPS, MAX_NAV_GROUP_LABEL } = require('../componentSpecs');
const { validateTheme } = require('../../core/cms/themeSpec');
const { isObject } = require('./shared');

/** design / nav (App Design v2 — OPTIONAL top-level keys). */
function checkDesignAndNav(def, screens, pushE, pushW) {
    // ── design / nav (App Design v2 — OPTIONAL top-level keys) ────────────
    // Canonicalize already normalizes these; validation here is the defensive
    // gate for canonical bytes handed in directly, mirroring the theme checks.
    if (def.design !== undefined) {
        if (!isObject(def.design)) {
            pushE({ code: 'design.invalid', severity: 'error', path: 'design', message: 'design must be an object.', hint: `Use the keys: ${Object.keys(DESIGN_SPEC).join(', ')}.` });
        } else {
            for (const [key, value] of Object.entries(def.design)) {
                const spec = DESIGN_SPEC[key];
                if (!spec) {
                    pushE({ code: 'design.unknown_key', severity: 'error', path: `design.${key}`, message: `Unknown design key "${key}".`, hint: `Use one of: ${Object.keys(DESIGN_SPEC).join(', ')}.` });
                } else if (spec.type === 'enum' && !spec.values.includes(value)) {
                    pushE({ code: 'design.value_invalid', severity: 'error', path: `design.${key}`, message: `design.${key} must be one of ${spec.values.join(', ')}.`, hint: `Got ${JSON.stringify(value)}.` });
                } else if (spec.type === 'url' && value !== null
                    && (typeof value !== 'string' || !/^https:\/\//.test(value) || value.length > spec.maxLen)) {
                    pushE({ code: 'design.value_invalid', severity: 'error', path: `design.${key}`, message: `design.${key} must be null or an https:// URL of at most ${spec.maxLen} characters.`, hint: 'Upload the logo somewhere reachable and paste its https URL.' });
                }
            }
        }
    }
    if (def.nav !== undefined) {
        if (!isObject(def.nav)) {
            pushE({ code: 'nav.invalid', severity: 'error', path: 'nav', message: 'nav must be an object.', hint: 'Use { style, groups? }.' });
        } else {
            if (!NAV_STYLES.includes(def.nav.style)) {
                pushE({ code: 'nav.value_invalid', severity: 'error', path: 'nav.style', message: `nav.style must be one of ${NAV_STYLES.join(', ')}.`, hint: `Got ${JSON.stringify(def.nav.style)}.` });
            }
            if (def.nav.groups !== undefined) {
                if (!Array.isArray(def.nav.groups) || def.nav.groups.length > MAX_NAV_GROUPS) {
                    pushE({ code: 'nav.groups_invalid', severity: 'error', path: 'nav.groups', message: `nav.groups must be an array of at most ${MAX_NAV_GROUPS} groups.`, hint: 'Each group is { id, label, icon, screens }.' });
                } else {
                    const screenByIdForNav = new Map(screens.filter(isObject).map((s) => [s.id, s]));
                    def.nav.groups.forEach((g, i) => {
                        const p = `nav.groups[${i}]`;
                        if (!isObject(g) || typeof g.label !== 'string' || !g.label
                            || g.label.length > MAX_NAV_GROUP_LABEL || !Array.isArray(g.screens)) {
                            pushE({ code: 'nav.group_invalid', severity: 'error', path: p, message: `Nav group must be { id, label (≤${MAX_NAV_GROUP_LABEL} chars), icon, screens[] }.`, hint: 'Give the group a short label and at least one screen.' });
                            return;
                        }
                        g.screens.forEach((sid) => {
                            const target = screenByIdForNav.get(sid);
                            if (!target) {
                                pushE({ code: 'nav.screen_unresolved', severity: 'error', path: `${p}.screens`, message: `Nav group "${g.label}" references unknown screen ${JSON.stringify(sid)}.`, hint: 'Point it at one of the screen ids.' });
                            } else if (target.showInNav === false) {
                                // Presentation contradiction, not a breakage: the
                                // group names a screen the nav is told to hide.
                                pushW({ code: 'nav.group_screen_hidden', severity: 'warning', path: `${p}.screens`, message: `Nav group "${g.label}" lists screen "${target.name || sid}", which has showInNav: false.`, hint: 'Either show the screen in navigation or drop it from the group.' });
                            }
                        });
                    });
                }
            }
        }
    }
}

/**
 * publicAccess: its own theme/design, and the approval_list warning.
 *
 * approval_list on a publicly shared screen is not a leak — the component shows
 * anonymous visitors a static sign-in wall and performs no fetch, and the API
 * behind it is session-authed with canView scoping. It IS a UX trap: a decide
 * surface placed where the audience can never decide. Say so at author time.
 */
function checkPublicAccess(def, pushE, pushW) {
    // The page's own look (publicAccess.theme / .design) speaks the app
    // theme's and design's vocabulary, so it gets their checks — partial
    // by design, and never `preset` (provenance, not a knob).
    const pa = def.publicAccess;
    if (pa.theme !== undefined) {
        if (!isObject(pa.theme)) {
            pushE({ code: 'publicAccess.theme_invalid', severity: 'error', path: 'publicAccess.theme', message: 'publicAccess.theme must be an object of theme knobs.', hint: 'e.g. { canvas: "#ffda00", accent: "#009b3e" } — name only what differs from the app theme.' });
        } else {
            for (const issue of validateTheme(pa.theme, 'publicAccess.theme')) {
                pushE({ code: `publicAccess.${issue.code}`, severity: 'error', path: issue.path, message: issue.message, hint: issue.hint });
            }
        }
    }
    if (pa.design !== undefined) {
        if (!isObject(pa.design)) {
            pushE({ code: 'publicAccess.design_invalid', severity: 'error', path: 'publicAccess.design', message: 'publicAccess.design must be an object of design knobs.', hint: `Use the keys: ${Object.keys(DESIGN_SPEC).filter((k) => k !== 'preset').join(', ')}.` });
        } else {
            for (const [key, value] of Object.entries(pa.design)) {
                const spec = key === 'preset' ? null : DESIGN_SPEC[key];
                if (!spec) {
                    pushE({ code: 'publicAccess.design_unknown_key', severity: 'error', path: `publicAccess.design.${key}`, message: `Unknown design key "${key}" on the public page.`, hint: `Use one of: ${Object.keys(DESIGN_SPEC).filter((k) => k !== 'preset').join(', ')}.` });
                } else if (value === null) {
                    continue; // "no override for this knob"
                } else if (spec.type === 'enum' && !spec.values.includes(value)) {
                    pushE({ code: 'publicAccess.design_value_invalid', severity: 'error', path: `publicAccess.design.${key}`, message: `publicAccess.design.${key} must be one of ${spec.values.join(', ')}.`, hint: `Got ${JSON.stringify(value)}.` });
                } else if (spec.type === 'url' && !(typeof value === 'string' && /^https:\/\//.test(value) && value.length <= spec.maxLen)) {
                    pushE({ code: 'publicAccess.design_value_invalid', severity: 'error', path: `publicAccess.design.${key}`, message: `publicAccess.design.${key} must be an https:// URL of at most ${spec.maxLen} characters.`, hint: 'Upload the logo somewhere reachable and paste its https URL.' });
                }
            }
        }
    }
    const publicIds = new Set(
        [def.publicAccess.entryScreenId, ...(Array.isArray(def.publicAccess.screenIds) ? def.publicAccess.screenIds : [])]
            .filter((id) => typeof id === 'string' && id));
    const holdsApprovalList = (nodes) => (Array.isArray(nodes) ? nodes : []).some(
        (n) => isObject(n) && (n.type === 'approval_list' || holdsApprovalList(n.children)));
    for (const screen of (Array.isArray(def.screens) ? def.screens : [])) {
        if (!isObject(screen) || !publicIds.has(screen.id)) continue;
        if ((Array.isArray(screen.sections) ? screen.sections : []).some((s) => isObject(s) && holdsApprovalList(s.children))) {
            pushW({
                code: 'publicAccess.approval_list_walled', severity: 'warning', path: `screens.${screen.id}`,
                message: `Screen "${screen.name || screen.id}" is publicly shared but contains an Approvals component — anonymous visitors only ever see a sign-in wall there.`,
                hint: 'Move the component to a members-only screen, or drop the screen from publicAccess.screenIds.',
            });
        }
    }
}

module.exports = { checkDesignAndNav, checkPublicAccess };
