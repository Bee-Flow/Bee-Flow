/**
 * App Studio builder tools — SCREENS and the SECTIONS inside them: add, update
 * (incl. making one home), remove, plus a section's creation and restyling.
 *
 * Two rules live here and nowhere else: the untouched default "Home" screen a
 * build's first screen takes over, and the person's own screen-count ceiling
 * (core/llm/screenConstraints) that the model cannot talk past.
 */

'use strict';

const { LIMITS, SCREEN_SPEC } = require('../../componentSpecs');
const ops = require('../../definitionOps');
const { pickClosestId } = require('../../../automation/validate/helpers');
const { isBinding: screenRuleBinds, describeScreenConstraints } = require('../../../core/llm/screenConstraints');
const { idHint, adoptCanonical } = require('../shared');


/**
 * The untouched default screen a new app starts with: the only screen, still
 * called Home, and nothing on it. A build's FIRST screen takes its place
 * (measured 2026-09-14: every playbook app kept an empty "Home" beside the
 * screens the model added — the person opened the app on a blank page).
 */
function untouchedDefaultScreen(def) {
    const screens = Array.isArray(def?.screens) ? def.screens : [];
    if (screens.length !== 1) return null;
    const scr = screens[0];
    if (!scr || String(scr.name || '').trim().toLowerCase() !== 'home') return null;
    const empty = (scr.sections || []).every((sec) => !sec || !Array.isArray(sec.children) || sec.children.length === 0);
    return empty ? scr : null;
}

function applyAddScreen(draftWrap, args) {
    if ((draftWrap.def.screens || []).length >= LIMITS.MAX_SCREENS) {
        return { error: `The app already has ${LIMITS.MAX_SCREENS} screens (the maximum). Remove or merge screens first.` };
    }
    const reuse = untouchedDefaultScreen(draftWrap.def);
    // The person's own screen count is a ceiling the model cannot talk past.
    // "Only a dashboard" and the model still opens a detail screen: refused
    // here with the screen to build on instead. Renaming the untouched default
    // "Home" does not add a screen, so the first add always lands.
    const rule = draftWrap._screenConstraint;
    if (screenRuleBinds(rule) && rule.exact) {
        const screens = draftWrap.def.screens || [];
        const renamesHome = !!(reuse && typeof args?.name === 'string' && args.name.trim() && args.name.trim().toLowerCase() !== 'home');
        const after = renamesHome ? screens.length : screens.length + 1;
        if (after > rule.screens) {
            const first = screens[0];
            const have = screens.map((sc) => `"${sc.name}" (${sc.id})`).join(', ');
            return {
                error: `The person asked for exactly ${rule.screens} screen${rule.screens === 1 ? '' : 's'} ("${rule.source}") and the app already has ${screens.length}: ${have}. A screen "${String(args?.name || '').trim() || 'new'}" was not added.`,
                _fixHint: `Put what this screen was for ON ${first ? `"${first.name}" (${first.id})` : 'the existing screen'} — a section with a data_grid, stat or chart there — and never navigate to a screen that does not exist. ${describeScreenConstraints(rule)}`,
                screenLimit: rule.screens,
            };
        }
    }
    let next = draftWrap.def;
    let screenId;
    if (reuse && typeof args?.name === 'string' && args.name.trim() && args.name.trim().toLowerCase() !== 'home') {
        screenId = reuse.id;
        next = ops.updateScreen(next, screenId, { name: args.name.trim() });
    } else {
        ({ def: next, screenId } = ops.addScreen(draftWrap.def, { name: args?.name }));
    }
    const patch = {};
    if (typeof args?.icon === 'string') patch.icon = args.icon;
    if (typeof args?.showInNav === 'boolean') patch.showInNav = args.showInNav;
    if (args?.maxWidth !== undefined) patch.maxWidth = args.maxWidth;
    // Unlike applyUpdateScreen (which walks SCREEN_SPEC), this path is an
    // explicit allowlist — a new screen field has to be added here too or the
    // model can set it on update but not on create.
    if (args?.refreshInterval !== undefined) patch.refreshInterval = args.refreshInterval;
    if (typeof args?.description === 'string') patch.description = args.description;
    // Not in SCREEN_SPEC (role KEYS are canonicalized against definition.roles,
    // not against a value list), so it needs a line of its own on BOTH paths —
    // canonicalize and validate have always accepted it, no tool could set it.
    if (Array.isArray(args?.visibleToRoles)) patch.visibleToRoles = args.visibleToRoles;
    if (Object.keys(patch).length) next = ops.updateScreen(next, screenId, patch);
    const sectionId = ops.findScreen(next, screenId)?.sections?.[0]?.id || null;
    // Remembered for a parent-less app_add_components that follows (defaultParentSection).
    draftWrap._lastAddedScreenId = screenId;
    const result = adoptCanonical(draftWrap, next, { screenId, sectionId });
    if (reuse && screenId === reuse.id) {
        result.reusedHome = true;
        result._hints = [...(result._hints || []), `The empty "Home" screen became "${args.name.trim()}" (${screenId}) — it is the home screen; no blank page is left behind. Build on it.`];
    }
    return result;
}

function applyUpdateScreen(draftWrap, args) {
    const screenId = typeof args?.screenId === 'string' ? args.screenId : null;
    if (!screenId || !ops.findScreen(draftWrap.def, screenId)) {
        const suggestion = pickClosestId(screenId, (draftWrap.def.screens || []).map((s) => s.id));
        return {
            error: `Unknown screenId ${JSON.stringify(screenId)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
            _fixHint: idHint(draftWrap.def),
        };
    }
    const patch = {};
    for (const k of Object.keys(SCREEN_SPEC)) {
        if (args?.[k] !== undefined) patch[k] = args[k];
    }
    // See applyAddScreen: visibleToRoles lives outside SCREEN_SPEC, so the walk
    // above cannot see it.
    if (Array.isArray(args?.visibleToRoles)) patch.visibleToRoles = args.visibleToRoles;
    let next = ops.updateScreen(draftWrap.def, screenId, patch);
    if (args?.makeHome === true) next = { ...next, homeScreenId: screenId };
    const result = adoptCanonical(draftWrap, next, {});
    const screen = ops.findScreen(draftWrap.def, screenId);
    result.screen = { id: screen.id, name: screen.name, icon: screen.icon, showInNav: screen.showInNav, maxWidth: screen.maxWidth };
    result.homeScreenId = draftWrap.def.homeScreenId;
    return result;
}

function applyRemoveScreen(draftWrap, args) {
    const screenId = args?.screenId;
    const def = draftWrap.def;
    if (!ops.findScreen(def, screenId)) {
        const suggestion = pickClosestId(screenId, (def.screens || []).map((s) => s.id));
        return { error: `Unknown screenId ${JSON.stringify(screenId)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, _fixHint: idHint(def) };
    }
    if ((def.screens || []).length <= 1) {
        return { error: 'An app needs at least one screen — add the replacement screen first, then remove this one.' };
    }
    const next = ops.removeScreen(def, screenId);
    // homeScreenId is repointed by ops AND re-resolved by canonicalize — read
    // it after adoption so the model is told where home actually ended up.
    const result = adoptCanonical(draftWrap, next, { removed: screenId });
    result.homeScreenId = draftWrap.def.homeScreenId;
    return result;
}

function applyAddSection(draftWrap, args) {
    const screenId = args?.screenId;
    const screen = ops.findScreen(draftWrap.def, screenId);
    if (!screen) {
        const suggestion = pickClosestId(screenId, (draftWrap.def.screens || []).map((s) => s.id));
        return { error: `Unknown screenId ${JSON.stringify(screenId)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, _fixHint: idHint(draftWrap.def) };
    }
    if ((screen.sections || []).length >= LIMITS.MAX_SECTIONS_PER_SCREEN) {
        return { error: `Screen "${screenId}" already has the maximum of ${LIMITS.MAX_SECTIONS_PER_SCREEN} sections.` };
    }
    let { def: next, sectionId } = ops.addSection(draftWrap.def, screenId, args?.index);
    if (args?.style && typeof args.style === 'object' && !Array.isArray(args.style)) {
        next = ops.updateSectionStyle(next, sectionId, args.style);
    }
    return adoptCanonical(draftWrap, next, { sectionId });
}

/**
 * app_update_section — restyle a section that already exists.
 *
 * Sections could be created with a style and never changed again: the only way
 * to fix a padding was to rebuild the screen around it. That gap has a sharp
 * edge — a section whose components have all been moved elsewhere keeps its
 * padding and renders as a band of empty space at the top of the screen, with
 * no tool able to close it.
 */
function applyUpdateSection(draftWrap, args) {
    const sectionId = args?.sectionId;
    const found = ops.findSection(draftWrap.def, sectionId);
    if (!found) {
        const all = (draftWrap.def.screens || []).flatMap((s) => (s.sections || []).map((sec) => sec.id));
        const suggestion = pickClosestId(sectionId, all);
        return { error: `Unknown sectionId ${JSON.stringify(sectionId)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`, _fixHint: idHint(draftWrap.def) };
    }
    if (!args?.style || typeof args.style !== 'object' || Array.isArray(args.style) || !Object.keys(args.style).length) {
        return { error: 'Nothing to change — pass a style object (padding, gap, background, height, heightMode, heightValue).' };
    }
    const next = ops.updateSectionStyle(draftWrap.def, sectionId, args.style);
    return adoptCanonical(draftWrap, next, { sectionId });
}

module.exports = {
    applyAddScreen,
    applyUpdateScreen,
    applyRemoveScreen,
    applyAddSection,
    applyUpdateSection,
};
