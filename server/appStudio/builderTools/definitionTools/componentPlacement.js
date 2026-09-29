/**
 * App Studio builder tools — WHERE a component goes: resolving the parent an
 * app_add_components / app_move_node call named (and the section a call that
 * named none most plausibly meant), and the one index rule that is not the
 * caller's — a batch that leads with a page_header goes to the top.
 */

'use strict';

const { CONTAINER_TYPES, getSpec } = require('../../componentSpecs');
const ops = require('../../definitionOps');
const { pickClosestId } = require('../../../automation/validate/helpers');
const { idHint } = require('../shared');

/**
 * Resolve an app_add_components / app_move_node parent target.
 * Returns { ok:true, isSection } or { error, _fixHint }.
 */
/** The section a parent-less batch most plausibly means — or null when the draft leaves it open. */
function defaultParentSection(def, draftWrap, args) {
    const screens = Array.isArray(def?.screens) ? def.screens : [];
    if (!screens.length) return null;
    const pick = (scr, why) => {
        const sec = scr && Array.isArray(scr.sections) ? scr.sections.find((x) => x && x.id) : null;
        return sec ? { sectionId: sec.id, screenName: scr.name || scr.id, why } : null;
    };
    // The call names a screen (id or title) instead of a section.
    const named = args && [args.screenId, args.screen, args.screenName].find((v) => typeof v === 'string' && v.trim());
    if (named) {
        const scr = screens.find((x) => x && (x.id === named.trim() || String(x.name || '').toLowerCase() === named.trim().toLowerCase()));
        const hit = pick(scr, ', the screen the call named');
        if (hit) return hit;
    }
    for (const [id, why] of [[draftWrap && draftWrap._lastAddedScreenId, ', added just before'], [draftWrap && draftWrap._lastTouchedScreenId, ', the screen being built']]) {
        if (!id) continue;
        const hit = pick(screens.find((x) => x && x.id === id), why);
        if (hit) return hit;
    }
    if (screens.length === 1) return pick(screens[0], ', the only screen');
    // Several screens, none touched this turn (a retry, a second turn): the
    // last one — a build fills screens in order, the last is the open one.
    return pick(screens[screens.length - 1], ', the last screen');
}

function resolveParent(def, parentId) {
    if (typeof parentId !== 'string' || !parentId) {
        return { error: 'parentId is required — a section id (sec_…) or a container component id (card/form).', _fixHint: idHint(def) };
    }
    if (ops.findSection(def, parentId)) return { ok: true, isSection: true };
    const found = ops.findNode(def, parentId);
    if (found) {
        const spec = getSpec(found.node.type);
        if (spec && spec.container) return { ok: true, isSection: false };
        return {
            error: `"${parentId}" is a ${found.node.type} — not a container. Only sections and container components (${CONTAINER_TYPES.join(', ')}) can hold children.`,
            _fixHint: 'Target the enclosing section id instead, or wrap the components in a card/form first.',
        };
    }
    const allIds = [...ops.collectIds(def)];
    const suggestion = pickClosestId(parentId, allIds);
    return {
        error: `Unknown parentId ${JSON.stringify(parentId)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
        _fixHint: `${idHint(def)} Read the draft state (or call app_get_draft) and use a real id.`,
    };
}

/**
 * Where a batch that OPENS with a page_header goes: index 0, or null for the
 * normal append.
 *
 * Components render in the order they are added, and nothing re-sorts them.
 * A header is therefore only a header if it arrives first — but a build that
 * had to recover (a batch that failed validation, then added one component at
 * a time) adds it whenever the model gets back to it, and the page renders
 * with its title at the BOTTOM. Measured 2026-09-16 on a live dashboard build:
 * a whole-screen call corrupted twice, the recovery added the six components
 * singly, and the page_header — sent last — was the last thing on the screen.
 *
 * Narrow on purpose: only into a SECTION (a card's children are a layout the
 * model chose), only when that section has no page_header yet, only when the
 * batch LEADS with one, and never against an explicit `index` — the caller
 * asked for a position and gets it. In all those cases the header is the
 * first thing the reader should see, so it goes first and the move is
 * reported as a hint.
 */
function pageHeaderBelongsOnTop(def, parentId, nodes) {
    if (!nodes.length || nodes[0]?.type !== 'page_header') return null;
    const found = ops.findSection(def, parentId);
    if (!found) return null;
    const children = found.section.children || [];
    if (!children.length) return null;
    if (children.some((c) => c && c.type === 'page_header')) return null;
    return 0;
}

module.exports = {
    defaultParentSection,
    resolveParent,
    pageHeaderBelongsOnTop,
};
