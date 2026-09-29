/**
 * App Studio Builder — live "tool draft" scanner.
 *
 * While the model streams an app_add_components call (a 3–10 KB document a
 * small model takes half a minute to write), the canvas used to show nothing
 * until the last brace. This reads the UNFINISHED arguments and says which
 * components it already describes — type, label, and whether the object is
 * still open — so the editor can place a ghost cell where the card will land.
 *
 * Built on the shared structural scan (core/llm/partialJsonScan.js): a light
 * tree of objects/arrays with their string-valued keys, read here by a
 * per-tool selector. Nothing here may throw — any exception yields the empty
 * result — and nothing here is ever fed back to the model or the definition.
 *
 * Shape: { items: [{ kind, type, label, partial }], count, parentId }
 *   kind     'component' | 'screen' | 'table' | 'action'
 *   type     the component type once its string has closed (aliases applied,
 *            so "kpi" previews as stat) — half a type name is not a type
 *   label    the label as typed so far (text/label/title/name), or null
 *   partial  the object is still open
 *   parentId the section/container the batch lands in, once terminated
 */

'use strict';

const {
    scanStructure, childObject, childArray, firstArray, objectElements, pick, cleanLabel,
} = require('../../../core/llm/partialJsonScan');
const { canonicalComponentType } = require('../../../appStudio/builderTools/componentAliases');

const MAX_ITEMS = 40;
const LABEL_KEYS = ['text', 'label', 'title', 'name', 'placeholder'];

const EMPTY = () => ({ items: [], count: 0, parentId: null });

/** The label of a component node: its own props first, then top-level keys (a model writes both). */
function labelOf(node) {
    const props = childObject(node, 'props');
    const s = pick([props, node], LABEL_KEYS, { any: true });
    return s ? cleanLabel(s.value) : null;
}

/** One component item; `children` are flattened after their parent, depth-first. */
function collectComponents(nodes, out, depth = 0) {
    for (const node of nodes) {
        if (out.length >= MAX_ITEMS) return;
        const typeStr = node.strings.get('type');
        out.push({
            kind: 'component',
            type: typeStr && typeStr.terminated ? canonicalComponentType(typeStr.value) : null,
            label: labelOf(node),
            partial: !node.closed,
        });
        if (depth < 4) {
            const kids = childArray(node, 'children');
            if (kids) collectComponents(objectElements(kids), out, depth + 1);
        }
    }
}

function scanAddComponents(root) {
    const list = childArray(root, 'components') || childArray(root, 'items') || childArray(root, 'children') || firstArray(root);
    const items = [];
    if (list) collectComponents(objectElements(list), items);
    const parent = pick([root], ['parentId', 'sectionId', 'containerId']);
    return { items, count: items.length, parentId: parent ? parent.value : null };
}

function scanSingle(root, kind, { typeKeys = [], labelKeys = LABEL_KEYS } = {}) {
    const t = typeKeys.length ? pick([root], typeKeys) : null;
    const l = pick([root], labelKeys, { any: true });
    return {
        items: [{ kind, type: t ? t.value : null, label: l ? cleanLabel(l.value) : null, partial: !root.closed }],
        count: 1,
        parentId: null,
    };
}

function scanActions(root) {
    // Single form { action:{kind,name} } or batch { actions:[{action:{…}}] }.
    const batch = childArray(root, 'actions');
    const entries = batch ? objectElements(batch) : [root];
    const items = [];
    for (const entry of entries) {
        if (items.length >= MAX_ITEMS) break;
        const action = childObject(entry, 'action') || entry;
        const k = pick([action], ['kind']);
        const l = pick([action, entry], ['name', 'label', 'title'], { any: true });
        items.push({ kind: 'action', type: k ? k.value : null, label: l ? cleanLabel(l.value) : null, partial: !action.closed });
    }
    return { items, count: items.length, parentId: null };
}

/**
 * What the partial arguments of `name` describe so far. Empty for tools whose
 * arguments are not a landing (edits, reads, finalize).
 */
function scanAppToolDraft(name, partialJson) {
    try {
        const root = scanStructure(partialJson);
        if (!root || root.kind !== 'object') return EMPTY();
        switch (name) {
            case 'app_add_components': return scanAddComponents(root);
            case 'app_add_screen': return scanSingle(root, 'screen', { labelKeys: ['name', 'title'] });
            case 'app_link_datatable':
            case 'app_upsert_table': return scanSingle(root, 'table', { labelKeys: ['name', 'key', 'datatableId'] });
            case 'app_set_action': return scanActions(root);
            default: return EMPTY();
        }
    } catch (_) {
        return EMPTY();
    }
}

/**
 * Change key for the draft throttle: the item count, each item's type and
 * whether it is still open, plus the parent — NOT the label text, which
 * changes on every token (the 250 ms interval carries that).
 */
function deriveAppDraftKey({ items, parentId } = {}) {
    const list = Array.isArray(items) ? items : [];
    return `${list.length}:${list.map((it) => `${it.kind}|${it.type || ''}|${it.partial ? '~' : (it.label || '')}`).join(';')}@${parentId || ''}`;
}

module.exports = { scanAppToolDraft, deriveAppDraftKey, MAX_ITEMS };
