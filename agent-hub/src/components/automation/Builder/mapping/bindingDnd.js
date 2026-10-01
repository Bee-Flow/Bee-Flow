// Shared drag/drop plumbing for the mapping fields (BindingField / TemplateField
// / FieldKeyCombobox / FieldPicker). Each re-declared the identical onDragOver +
// path-extraction for `application/x-binding-path` drags from the VariableTree;
// the per-field drop ACTION (insert vs replace vs last-segment) stays local.
//
// Two drag types carry a value, and nothing else is ever read as one:
//   application/x-binding-path   the legacy path string these fields store
//   application/x-beeflow-source the value as a Source (valueSlot/slotDnd.ts),
//                                what the value slots read
// A drag from the builder sets both. A drop that carries neither (words
// dragged inside a prompt, text from another window) is left to the browser:
// reading `text/plain` as a path turned a moved sentence into a
// `{{some words}}` binding that resolves to nothing.
import { legacyPathOf, sourceFromPath } from '@shared/mapping/index.mjs';
import { SOURCE_MIME, isSourceDrag, parseDraggedSource } from '../valueSlot/slotDnd';

const BINDING_MIME = 'application/x-binding-path';

/**
 * dragstart handler: publish a variable path as a binding drag, and as a
 * Source drag when the path names one. `extra` adds what the caller knows
 * about the value (its Source, labelParts, shape, count).
 *
 * `text/plain` is set too, for a plain <input> without a binding handler
 * (App Studio's); no mapping field ever reads it.
 *
 * Lives here rather than in VariableTree (which re-exports it) because the
 * VariablePicker popover is a drag source too, and pulling a React component
 * module in for a four-line DOM helper is the wrong dependency direction.
 *
 * @param {{ dataTransfer: DataTransfer }} e
 * @param {string} path
 * @param {Record<string, unknown> | null} [extra]
 */
export function startPathDrag(e, path, extra = null) {
    e.dataTransfer.setData('text/plain', path);
    e.dataTransfer.setData(BINDING_MIME, path);
    const source = extra?.source || sourceFromPath(path);
    if (source) e.dataTransfer.setData(SOURCE_MIME, JSON.stringify({ ...(extra || {}), source }));
    e.dataTransfer.effectAllowed = 'copy';
}

/** Does this drag carry a value, in either of the two types? */
function isValueDrag(e) {
    const types = e.dataTransfer?.types;
    return (!!types && Array.from(types).includes(BINDING_MIME)) || isSourceDrag(e);
}

/** dragover handler: accept value drags and show the copy cursor; leave any other drag alone. */
export function onBindingDragOver(e) {
    if (!isValueDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
}

/**
 * Read the dropped binding path, calling preventDefault when present: the
 * legacy path the drag carries, else its Source written as one. Returns
 * null for a drop that carries no value; `text/plain` is never read.
 */
export function getBindingDropPath(e) {
    let path = e.dataTransfer?.getData(BINDING_MIME) || '';
    if (!path) {
        const dragged = parseDraggedSource(e.dataTransfer?.getData(SOURCE_MIME));
        path = (dragged && legacyPathOf(dragged.source)) || '';
    }
    if (!path) return null;
    e.preventDefault();
    return path;
}
