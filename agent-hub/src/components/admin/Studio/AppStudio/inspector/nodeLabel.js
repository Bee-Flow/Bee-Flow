import { getComponentEntry } from '../runtime/componentRegistry';

/**
 * What a component is CALLED — the instance, not the type.
 *
 * The inspector header used to show the TYPE ("Button"), which is the one thing
 * the author already knows: they just clicked the button. What they cannot see
 * from the canvas alone is WHICH button they have selected once a screen has
 * four of them, and that is the node's own text.
 *
 * Three modules had already grown their own copy of this — ActionsSection's
 * `componentLabel` (for the shared-action warning), rbac/AccessMatrix's
 * `nodeLabel` and editor/dryRunIssues' `nodeLabel`. All three walk the same
 * four props in the same order; all three would have to change together the day
 * a component gets a fifth naming prop. The header is where the fourth copy
 * would have gone.
 *
 * Order matters and is not arbitrary: `label` is what an input and a button
 * carry, `title` what a card/modal carries, `text` what a heading and a plain
 * text block carry, `heading` what a section-ish component carries. First one
 * with real text wins.
 */

const NAMING_PROPS = ['label', 'title', 'text', 'heading'];

/**
 * The component's own text, trimmed and capped, or '' when it has none.
 *
 * A plain slice, no ellipsis — the header truncates in CSS (which knows the
 * actual width) and the warning form has always cut at 24 characters. Adding a
 * character here would change every existing warning string by one.
 */
export function nodeOwnText(node, max = 40) {
    const props = node?.props || {};
    for (const key of NAMING_PROPS) {
        const value = props[key];
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, max);
    }
    return '';
}

/**
 * The TYPE's display name ("Button", "Data grid"), for the header eyebrow.
 * Falls back to the raw type — an unknown type is better named by its id than
 * by nothing.
 */
export function nodeTypeLabel(node) {
    return getComponentEntry(node?.type)?.label || node?.type || 'Component';
}

/**
 * The instance name for a header: the component's own text when it has any,
 * and the type name when it does not.
 *
 * A node with no text of its own is genuinely unnamed, and "Button" is then the
 * truest thing that can be said about it — inventing "Untitled button" would
 * claim a name the app does not have.
 */
export function nodeLabel(node) {
    return nodeOwnText(node) || nodeTypeLabel(node);
}

/**
 * `Button “Save”` — the form used in WARNINGS, where the reader needs both the
 * kind of thing and which one. This is ActionsSection's `componentLabel`,
 * unchanged, so the shared-action and delete dialogs keep reading exactly as
 * they did.
 */
export function nodeLabelWithType(node) {
    const base = nodeTypeLabel(node);
    const text = nodeOwnText(node, 24);
    return text ? `${base} “${text}”` : base;
}

export default nodeLabel;
