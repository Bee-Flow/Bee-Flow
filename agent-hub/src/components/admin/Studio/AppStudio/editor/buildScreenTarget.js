/**
 * Which screen the AI is building right now — the chapter the canvas should
 * be showing.
 *
 * Measured 2026-09-13: the model created a "Suppliers" screen and filled it
 * with two forms while the viewer looked at Home and saw nothing land. The
 * pane used to switch screens off a cumulative diff, which could not fire
 * once anything had landed on the active screen earlier in the turn; and it
 * only knew about a screen after the draft, never while the components for it
 * were still being typed. The camera hook (useBuildFollow) asks this module
 * instead, on every cue change, against the LIVE definition:
 *
 *   'typing'  the batch being typed names its parent (`tool_draft.parentId`,
 *             a sec_… or a container cmp_…) → that parent's screen. Wins,
 *             because it is the earliest signal — the switch happens BEFORE
 *             the cells land, so the ghost cell shows on the right screen.
 *   'screen'  the last call added a screen → that screen (a chapter break).
 *   'landed'  the last reveal plan's first id that sits on a screen.
 *
 * Pure. Returns null when nothing in the cue points at a screen (a theme or
 * table call); the caller keeps its last answer.
 */

import { findNode, findScreen, findSection } from '../state/definitionOps';

/** The screen an id lives on: a screen id → itself, a section → its screen, a component → its screen. */
export function screenOfNode(def, id) {
    if (!def || typeof id !== 'string' || !id) return null;
    if (findScreen(def, id)) return id;
    const sec = findSection(def, id);
    if (sec) return sec.screen.id;
    const found = findNode(def, id);
    return found && found.screen ? found.screen.id : null;
}

/**
 * @param {{ definition, toolDraft, lastCall, reveal }} cue
 * @returns {{ id: string, name: string, reason: 'typing'|'screen'|'landed' } | null}
 */
function typingTarget(definition, toolDraft) {
    return toolDraft && typeof toolDraft.parentId === 'string' ? screenOfNode(definition, toolDraft.parentId) : null;
}

function addedScreenTarget(definition, lastCall, reveal) {
    const added = lastCall && Array.isArray(lastCall.added) ? lastCall.added : [];
    const screenAdded = added.find((a) => a && a.type === 'screen' && typeof a.id === 'string');
    if (screenAdded && findScreen(definition, screenAdded.id)) return screenAdded.id;
    const planScreens = reveal && reveal.plan && Array.isArray(reveal.plan.screens) ? reveal.plan.screens : [];
    return planScreens.find((id) => findScreen(definition, id)) || null;
}

function landedTarget(definition, reveal) {
    const planIds = reveal && reveal.plan && Array.isArray(reveal.plan.ids) ? reveal.plan.ids : [];
    for (const id of planIds) {
        const on = screenOfNode(definition, id);
        if (on) return on;
    }
    return null;
}

export function resolveBuildScreen({ definition, toolDraft, lastCall, reveal } = {}) {
    if (!definition) return null;
    const answer = (id, reason) => {
        const screen = id ? findScreen(definition, id) : null;
        return screen ? { id: screen.id, name: screen.name || '', reason } : null;
    };
    return answer(typingTarget(definition, toolDraft), 'typing')
        || answer(addedScreenTarget(definition, lastCall, reveal), 'screen')
        || answer(landedTarget(definition, reveal), 'landed');
}
