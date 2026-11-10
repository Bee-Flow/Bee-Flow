/**
 * App Studio builder: the full catalogue entry of an extension item that is not a component
 * type, a knob, a step or an action (extensionIndex.mts renders those):
 *
 *   a screen, theme or design key          from its spec entry
 *   a key of the items of a list prop      from the prop's itemShape
 *   an event an existing type newly fires  one fixed sentence
 *   a section, node, nav or nav-group key  from its key file (componentSpecs/keys/): `shape — description`
 *   a word of the data vocabulary          from its mark (core/dataEngine/dataModel/vocabularySince.js)
 *
 * An enum value is answered with the entry of the key that holds it, like everywhere else.
 */

import { createRequire } from 'node:module';
import { catalogueMarks, fullCatalogue } from '../catalogTiers.mts';
import type { ExtensionItem } from '../catalogTiers.mts';

type FieldSpec = { type?: string; values?: unknown[]; default?: unknown; description?: unknown; optional?: unknown; maxLen?: unknown; itemShape?: Record<string, FieldSpec> } & Record<string, unknown>;
type Mark = { shape?: unknown; description?: unknown };

const nodeRequire = createRequire(import.meta.url);
const render = nodeRequire('./catalogRender.js') as {
    renderPropSpec: (key: string, spec: FieldSpec) => string;
    renderStyleKnobEntry: (key: string) => string;
};
const { valueTypeOf } = nodeRequire('../componentSpecs/valueTypes.js') as {
    valueTypeOf: (spec: unknown) => { render: (key: string, spec: unknown) => string } | null;
};

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const withNote = (line: string, note: string): string => (note ? `${line} — ${note}` : line);

/** How each key-mark family and data family words its entry. */
const KEY_PREFIX: Readonly<Record<string, string>> = Object.freeze({ section: 'section.', node: 'node.', nav: 'nav.', navGroup: 'nav.groups[].' });
const DATA_LABEL: Readonly<Record<string, string>> = Object.freeze({ fieldTypes: 'field type', filterOps: 'filter op', aggFns: 'aggregate fn', dateBuckets: 'date bucket' });

/** One theme or design key: its values, its default when it has one, its own description. */
function lookKey(prefix: string, key: string, spec: FieldSpec): string {
    const note = text(spec.description);
    const valueType = valueTypeOf(spec);
    if (valueType) return withNote(`${prefix}.${valueType.render(key, spec)}`, note);
    if (spec.type === 'enum' && Array.isArray(spec.values)) {
        const fallback = spec.optional || spec.default === undefined || spec.default === null ? '' : ` (default ${String(spec.default)})`;
        return withNote(`${prefix}.${key}: ${spec.values.map(String).join('|')}${fallback}`, note);
    }
    if (spec.type === 'color') return withNote(`${prefix}.${key}: #rrggbb or unset`, note);
    if (spec.type === 'url') return withNote(`${prefix}.${key}: https:// URL or null`, note);
    return withNote(`${prefix}.${key}: ${text(spec.type) || 'value'}`, note);
}

function tableEntry(item: ExtensionItem): string | null {
    const full = fullCatalogue();
    const table = item.ownerTable === 'screen' ? full.SCREEN_SPEC : item.ownerTable === 'theme' ? full.THEME_SPEC : full.DESIGN_SPEC;
    const spec = (table as unknown as Record<string, FieldSpec | undefined>)[item.key || ''];
    if (!spec) return null;
    // A screen key reads like a prop (the Screens line of the catalogue is rendered the same way).
    return item.ownerTable === 'screen' ? `screen.${render.renderPropSpec(item.key as string, spec)}` : lookKey(item.ownerTable as string, item.key as string, spec);
}

function itemEntry(item: ExtensionItem): string | null {
    const [prop, ...rest] = item.path || [];
    const types = fullCatalogue().COMPONENT_SPECS as unknown as Record<string, { props?: Record<string, FieldSpec> } | undefined>;
    let shape = types[item.owner || '']?.props?.[prop || '']?.itemShape;
    for (const step of rest.slice(0, -1)) shape = shape?.[step]?.itemShape;
    const spec = shape?.[item.key || ''];
    if (!spec) return null;
    const at = [prop, ...rest.slice(0, -1)].map((part) => `${part}[]`).join('.');
    return `${item.owner}.${at}.${render.renderPropSpec(item.key as string, spec)}`;
}

function keyMarkEntry(item: ExtensionItem): string | null {
    const mark = (catalogueMarks().keyMarks[item.owner || ''] as Record<string, Mark> | undefined)?.[item.key || ''];
    if (!mark) return null;
    if (item.owner === 'sectionStyle') return withNote(`section.style.${render.renderStyleKnobEntry(item.key as string)}`, text(mark.description));
    return withNote(`${KEY_PREFIX[item.owner || ''] || ''}${item.key}: ${text(mark.shape)}`, text(mark.description));
}

function dataEntry(item: ExtensionItem): string | null {
    const mark = (catalogueMarks().dataMarks[item.owner || ''] as Record<string, Mark> | undefined)?.[item.key || ''];
    if (!mark) return null;
    if (item.owner === 'fieldOptions') return withNote(`field.${item.key}: ${text(mark.shape)}`, text(mark.description));
    return withNote(`${DATA_LABEL[item.owner || ''] || 'data'} "${item.key}"`, text(mark.description));
}

/** The entry of an item this module owns, or null for one it does not (or whose source is gone). */
export function renderKeyEntry(item: ExtensionItem): string | null {
    switch (item.ownerTable) {
        case 'screen': case 'theme': case 'design': return tableEntry(item);
        case 'item': return itemEntry(item);
        case 'event': return `${item.owner} also fires ${item.key}: bind an action to it with app_bind_action { event: "${item.key}" }`;
        case 'keys': return keyMarkEntry(item);
        case 'data': return dataEntry(item);
        default: return null;
    }
}
