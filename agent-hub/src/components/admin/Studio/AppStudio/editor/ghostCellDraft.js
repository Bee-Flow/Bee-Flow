/**
 * The card being TYPED, projected onto the App Studio canvas — the pure half
 * of the ghost cell (the sibling of automation/Builder/flow/ghostDraft.js).
 *
 * The server scans the model's streaming tool arguments and sends
 * `tool_draft { name, items:[{kind,type,label,partial}], count, parentId }`.
 * The LAST item is the one under the cursor: its type (once the string has
 * closed — half a type name is not a type), its label as typed so far, and
 * whether it is still open. This says WHERE it will land — the section on
 * the active screen the batch targets — and HOW WIDE (the type's default
 * span), so the ghost holds the slot the real cell is about to take.
 *
 * One card at a time on purpose: a forty-entry batch types for a minute on a
 * local model, and forty dashed cells would be the shuffle the film exists to
 * avoid. The kicker counts ("Component 2 of 5") so the pace is visible.
 */

import { APP_COMPONENT_TYPES } from '../runtime/componentRegistry';
import { findNode, findScreen, findSection } from '../state/definitionOps';

const KINDS_ON_CANVAS = new Set(['component']);

function sectionIdsOf(screen) {
    return new Set((screen && Array.isArray(screen.sections) ? screen.sections : []).map((s) => s && s.id).filter(Boolean));
}

/**
 * @returns {null | { kind:'component', type, typeLabel, label, partial, index, count, sectionId, span, caption }}
 */
/** The section the ghost belongs in on `screen`, or null when the parent is on another screen. */
function ghostSectionFor(parent, definition, screen, sections) {
    if (parent && sections.has(parent)) return parent;
    if (parent) {
        const found = findNode(definition, parent);
        if (found && found.screen && found.section) return found.screen.id === screen.id ? found.section.id : null;
        if (findSection(definition, parent)) return null; // a section of another screen
    }
    return screen.sections[screen.sections.length - 1].id;
}

export function projectGhostCell(toolDraft, definition, activeScreenId, t = null) {
    if (!toolDraft || toolDraft.name !== 'app_add_components') return null;
    const items = Array.isArray(toolDraft.items) ? toolDraft.items.filter((i) => i && KINDS_ON_CANVAS.has(i.kind)) : [];
    if (!items.length) return null;
    const screen = findScreen(definition, activeScreenId);
    if (!screen) return null;
    const sections = sectionIdsOf(screen);
    if (!sections.size) return null;

    // Where: the batch's parent when it is a section of this screen; a
    // container's own section when the parent is a card/form here. A parent
    // that resolves to ANOTHER screen draws nothing — the camera
    // (useBuildFollow) switches to that screen on its next tick and the ghost
    // then lands in the right section; drawing it here first put the card in
    // the wrong place on the wrong screen (2026-09-13). A parent not typed yet
    // or unknown anywhere falls back to this screen's last section.
    const sectionId = ghostSectionFor(toolDraft.parentId, definition, screen, sections);
    if (!sectionId) return null;

    const last = items[items.length - 1];
    const type = typeof last.type === 'string' && APP_COMPONENT_TYPES[last.type] ? last.type : null;
    const entry = type ? APP_COMPONENT_TYPES[type] : null;
    const typeLabel = entry ? (entry.label || type) : (t ? t('app_studio.builder.draft.component', 'Component') : 'Component');
    const span = entry && entry.defaultStyle && Number.isFinite(entry.defaultStyle.span) ? entry.defaultStyle.span : 12;
    const index = items.length;
    const count = Number.isFinite(toolDraft.count) && toolDraft.count >= index ? toolDraft.count : index;
    const label = typeof last.label === 'string' && last.label.trim() ? last.label.trim() : null;
    const caption = label
        || (t ? t('app_studio.builder.draft.typing', 'Adding {type}…', { type: typeLabel }) : `Adding ${typeLabel}…`);
    return { kind: 'component', type, typeLabel, label, partial: last.partial !== false, index, count, sectionId, span, caption };
}
