/**
 * App Studio builder tools — the app as a WHOLE: its meta (name, description,
 * icon), its look (the classic theme knobs, the App Design v2 knobs and the
 * presets that materialize both) and how its screens are grouped in the nav.
 *
 * Every echo is read off draftWrap.def AFTER adoptCanonical has reassigned it,
 * so the model is told what was STORED rather than what it sent.
 */

'use strict';

const { THEME_SPEC, DESIGN_SPEC } = require('../../componentSpecs');
const { APP_DESIGN_PRESETS, getAppDesignPreset } = require('../../appDesignPresets');
const ops = require('../../definitionOps');
const { adoptCanonical } = require('../shared');

function applySetMeta(draftWrap, args) {
    const patch = {};
    for (const k of ['name', 'description', 'icon']) {
        if (typeof args?.[k] === 'string') patch[k] = args[k];
    }
    if (!Object.keys(patch).length) {
        return { error: 'Pass at least one of: name, description, icon (strings).' };
    }
    const next = ops.updateMeta(draftWrap.def, patch);
    // Echo the STORED meta, not the pre-canonicalize patch: a name over
    // MAX_NAME_LEN is truncated and a blank one becomes "Untitled app", and an
    // echo of the input would tell the model neither happened.
    const result = adoptCanonical(draftWrap, next, {});
    result.meta = { ...draftWrap.def.meta };
    return result;
}

/**
 * Restyle the app: the five classic theme knobs, the App Design v2 knobs
 * (design.*), the nav style — or `preset`, which MATERIALIZES a whole look
 * (theme + design + navStyle) in one call. A preset plus explicit knobs is
 * legal and the explicit knobs win, so "cloud but red" is one call.
 */
function applySetTheme(draftWrap, args) {
    const themePatch = {};
    const designPatch = {};
    let navPatch = null;

    const preset = typeof args?.preset === 'string' ? getAppDesignPreset(args.preset) : null;
    if (args?.preset !== undefined && !preset) {
        return { error: `Unknown preset ${JSON.stringify(args.preset)}. Legal: ${APP_DESIGN_PRESETS.map((p) => p.id).join(', ')}.` };
    }
    if (preset) {
        Object.assign(themePatch, preset.theme);
        Object.assign(designPatch, preset.design);
        navPatch = { style: preset.navStyle };
    }

    for (const k of Object.keys(THEME_SPEC)) {
        if (args?.[k] === undefined) continue;
        // An OPTIONAL colour clears with '' (the schema is string-typed, so
        // null cannot travel); the canonicalizer then drops the key.
        themePatch[k] = (THEME_SPEC[k].optional && args[k] === '') ? null : args[k];
    }
    for (const k of Object.keys(DESIGN_SPEC)) {
        if (k === 'preset') continue; // provenance, set by the branch above
        if (args?.[k] !== undefined) {
            designPatch[k] = args[k];
            // Diverging from a preset makes the look the author's own.
            if (!preset) designPatch.preset = 'custom';
        }
    }
    if (args?.navStyle !== undefined) navPatch = { style: args.navStyle };

    if (!Object.keys(themePatch).length && !Object.keys(designPatch).length && !navPatch) {
        return { error: `Pass a preset (${APP_DESIGN_PRESETS.map((p) => p.id).join(', ')}), a theme knob (${Object.keys(THEME_SPEC).join(', ')}), a design knob (${Object.keys(DESIGN_SPEC).filter((k) => k !== 'preset').join(', ')}) or navStyle.` };
    }

    let next = draftWrap.def;
    if (Object.keys(themePatch).length) next = ops.updateTheme(next, themePatch);
    if (Object.keys(designPatch).length) next = ops.updateDesign(next, designPatch);
    if (navPatch) next = ops.updateNav(next, navPatch);

    const result = adoptCanonical(draftWrap, next, {});
    result.theme = { ...draftWrap.def.theme };
    if (draftWrap.def.design) result.design = { ...draftWrap.def.design };
    if (draftWrap.def.nav) result.nav = { ...draftWrap.def.nav };
    return result;
}

/**
 * Group screens in the nav.
 *
 * The `mega` and `sidebar` styles show screens under labelled headings, and
 * until now nothing on this surface could write them: the editor has had a
 * NavGroups dialog since day one, but a builder could only choose the STYLE.
 * The result was an app whose nav read "Inzicht ▾ | Beheer ▾ | some loose
 * screen" — the ungrouped screen sitting beside the groups rather than in one.
 *
 * The whole list is replaced, not patched, because the invariants are
 * whole-list invariants: a screen belongs to exactly one group, and the group
 * order IS the nav order. A patch API would make "move this screen from A to
 * B" two calls with an illegal state in between.
 *
 * Everything else is the canonicalizer's job and is deliberately not repeated
 * here — it mints missing ids, trims labels, drops refs to screens that do not
 * exist, keeps the first of a duplicate, and drops groups left empty. Its
 * repairs come back as `_hints`, so a caller learns what happened rather than
 * silently getting something else.
 */
function applySetNavGroups(draftWrap, args) {
    const groups = args?.groups;
    if (groups === null) {
        const next = ops.updateNav(draftWrap.def, { groups: undefined });
        const cleared = next.nav ? { ...next.nav } : {};
        delete cleared.groups;
        const result = adoptCanonical(draftWrap, { ...next, nav: cleared }, {});
        result.nav = draftWrap.def.nav ? { ...draftWrap.def.nav } : null;
        return result;
    }
    if (!Array.isArray(groups)) {
        return { error: 'Pass `groups`: an array of { label, screens[], id?, icon? } — or null to ungroup every screen.' };
    }
    // A screen the caller forgot is not an error, but it IS the mistake worth
    // naming: it stays in the nav, just loose beside the groups rather than in
    // one. Listing them is cheaper than the caller re-reading the draft.
    const grouped = new Set(groups.flatMap((g) => (Array.isArray(g?.screens) ? g.screens : [])));
    const loose = (draftWrap.def.screens || [])
        .filter((s) => s && s.showInNav !== false && !grouped.has(s.id))
        .map((s) => s.id);

    const next = ops.updateNav(draftWrap.def, { groups });
    const result = adoptCanonical(draftWrap, next, {});
    result.nav = draftWrap.def.nav ? { ...draftWrap.def.nav } : null;
    if (loose.length) result.ungroupedScreens = loose;
    return result;
}

module.exports = {
    applySetMeta,
    applySetTheme,
    applySetNavGroups,
};
