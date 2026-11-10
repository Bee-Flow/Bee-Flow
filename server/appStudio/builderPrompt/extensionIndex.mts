/**
 * App Studio builder: the extension tier of the catalogue, as the model reads it.
 *
 * The system prompt renders the BASE catalogue (catalogTiers.mts). Everything marked `since: 3`
 * or higher reaches the model in two steps:
 *
 *   renderExtensionIndex()   ONE generated section, a line per family: the item's name and a short
 *                            gloss from its own description (names only in the compact form).
 *                            Empty when the catalogue has no extension entry, so the prompt is
 *                            then byte for byte what it was.
 *   inspectExtensions()      the full entry of named items, or of a whole family, for
 *                            app_inspect_catalog. Rendered by the functions the base catalogue uses.
 *
 * Deterministic: items are sorted (catalogTiers.extensionItems) and nothing here depends on the
 * request, so the text changes once per deploy that adds an entry and never per turn.
 */

import { createRequire } from 'node:module';
import { EXTENSION_FAMILIES, extensionItems, fullCatalogue } from '../catalogTiers.mts';
import type { ExtensionFamily, ExtensionItem } from '../catalogTiers.mts';
import { definitionKeys } from '../definitionKeyRegistry.mts';
import { INSPECT_MAX_EXTENSIONS, INSPECT_MAX_FAMILY_ENTRIES } from '../builderTools/schemaTiers.mts';

type FieldSpec = { description?: unknown } & Record<string, unknown>;

const nodeRequire = createRequire(import.meta.url);
const render = nodeRequire('./catalogRender.js') as {
    renderComponentEntry: (type: string) => string | null;
    renderStepEntry: (kind: string) => string | null;
    renderPropSpec: (key: string, spec: FieldSpec) => string;
    renderActionField: (key: string, spec: FieldSpec) => string;
    renderSpecFields: (fields: Record<string, FieldSpec>) => string;
    renderStyleKnobEntry: (key: string) => string;
};
const specs = nodeRequire('../componentSpecs.js') as {
    EXTENSION_STYLE_KNOB_GROUPS: readonly { grantedBy: string; knobs: readonly string[] }[];
    BINDING_KIND_DOCS: Record<string, { shape?: unknown; description?: unknown } | undefined>;
};

/** A gloss in the index is at most this long: the index budget counts on it. */
export const GLOSS_MAX_CHARS = 72;

const HEADING = '### Extensions (newer catalog items: legal too, but NOT described in the sections above)';
const RULE = 'Each line below only says that an item exists. BEFORE you use one, call app_inspect_catalog {extensions:["<name>", …]} (or {family:"<family>"} for a whole line) and write it from the full entry you get back.';

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The first sentence of a description, cut at a word boundary past the cap. No trailing full stop. */
export function gloss(description: string, max: number = GLOSS_MAX_CHARS): string {
    const flat = description.split('\n').join(' ').trim();
    const stop = flat.indexOf('. ');
    const first = stop >= 0 ? flat.slice(0, stop) : (flat.endsWith('.') ? flat.slice(0, -1) : flat);
    if (first.length <= max) return first;
    const cut = first.lastIndexOf(' ', max - 1);
    return `${first.slice(0, cut > max / 2 ? cut : max - 1)}…`;
}

/** The index section for `items`: '' for none. Pure, so the budget test can size it. */
export function renderIndexOf(items: readonly ExtensionItem[], { compact = false }: { compact?: boolean } = {}): string {
    if (!items.length) return '';
    const lines: string[] = [HEADING, RULE];
    for (const family of EXTENSION_FAMILIES) {
        const members = items.filter((item) => item.family === family);
        if (!members.length) continue;
        const entries = members.map((item) => {
            const short = compact ? '' : gloss(item.description);
            return short ? `${item.name} — ${short}` : item.name;
        });
        lines.push(`${family}: ${entries.join(compact ? ', ' : '; ')}`);
    }
    return lines.join('\n');
}

/** The extension index of the live catalogue: '' when it has no extension entry. */
export function renderExtensionIndex(opts: { compact?: boolean } = {}): string {
    return renderIndexOf(extensionItems(), opts);
}

const withNote = (line: string, note: string): string => (note ? `${line} — ${note}` : line);

function fieldEntry(item: ExtensionItem, label: string): string | null {
    const table = item.ownerTable === 'step' ? fullCatalogue().STEP_SPECS : fullCatalogue().ACTION_SPECS;
    const kinds = table as unknown as Record<string, { fields?: Record<string, FieldSpec> } | undefined>;
    const spec = kinds[item.owner || '']?.fields?.[item.key || ''];
    if (!spec) return null;
    return withNote(`${item.owner} ${label} field ${render.renderActionField(item.key as string, spec)}`, text(spec.description));
}

function knobEntry(knob: string): string {
    const group = specs.EXTENSION_STYLE_KNOB_GROUPS.find((g) => g.knobs.includes(knob));
    const table = fullCatalogue().STYLE_KNOBS as unknown as Record<string, FieldSpec | undefined>;
    const granted = !group ? '' : group.grantedBy === '*'
        ? 'on every component type and on a section'
        : `on every type whose style line includes \`${group.grantedBy}\``;
    return withNote(withNote(`style.${render.renderStyleKnobEntry(knob)}`, granted), text(table[knob]?.description));
}

function ownedEntry(item: ExtensionItem): string | null {
    if (item.ownerTable === 'knob') return knobEntry(item.key as string);
    if (item.ownerTable === 'step') return fieldEntry(item, 'step');
    if (item.ownerTable === 'action') return fieldEntry(item, 'action');
    const types = fullCatalogue().COMPONENT_SPECS as unknown as Record<string, { props?: Record<string, FieldSpec> } | undefined>;
    const spec = types[item.owner || '']?.props?.[item.key || ''];
    return spec ? `${item.owner}.${render.renderPropSpec(item.key as string, spec)}` : null;
}

/** The full catalogue entry of one extension item (an enum value is answered with its owner's entry). */
export function renderExtensionEntry(item: ExtensionItem): string {
    const fallback = withNote(item.name, item.description);
    switch (item.family) {
        case 'componentTypes': return render.renderComponentEntry(item.name) || fallback;
        case 'stepKinds': return withNote(render.renderStepEntry(item.name) || item.name, item.description);
        case 'actionKinds': {
            const spec = (fullCatalogue().ACTION_SPECS as unknown as Record<string, { fields: Record<string, FieldSpec> } | undefined>)[item.name];
            return withNote(spec ? `${item.name}: { ${render.renderSpecFields(spec.fields)} }` : item.name, item.description);
        }
        case 'bindingKinds': return withNote(text(specs.BINDING_KIND_DOCS[item.name]?.shape) || `{ "kind": "${item.name}", … }`, item.description);
        case 'topLevelKeys': {
            const shape = text(definitionKeys().find((entry) => entry.key === item.name)?.shape);
            return withNote(shape ? `${item.name}: ${shape}` : item.name, item.description);
        }
        default: return ownedEntry(item) || fallback;
    }
}

export interface ExtensionAnswer {
    /** name → full entry. Two families may hold the same name (a field of an action and of its step twin): both are answered. */
    entries: Record<string, string>;
    unknown: string[];
    notes: string[];
}

const isFamily = (v: unknown): v is ExtensionFamily => typeof v === 'string' && (EXTENSION_FAMILIES as readonly string[]).includes(v);

/** Answer `names` and/or one whole `family` from the extension tier. Total: an unknown name is reported, never thrown. */
export function inspectExtensions(names: readonly string[], family: unknown): ExtensionAnswer {
    const items = extensionItems();
    const answer: ExtensionAnswer = { entries: {}, unknown: [], notes: [] };
    const put = (item: ExtensionItem) => {
        const entry = renderExtensionEntry(item);
        const key = Object.hasOwn(answer.entries, item.name) && answer.entries[item.name] !== entry ? `${item.name} (${item.family})` : item.name;
        answer.entries[key] = entry;
    };
    const asked = names.slice(0, INSPECT_MAX_EXTENSIONS);
    for (const name of asked) {
        const hits = items.filter((item) => item.name === name);
        if (hits.length) hits.forEach(put);
        else answer.unknown.push(`${name} is not an extension item (base types and step kinds: ask with components / steps)`);
    }
    if (names.length > asked.length) answer.notes.push(`Only the first ${INSPECT_MAX_EXTENSIONS} extension names per call are answered: ask again for ${names.slice(asked.length).join(', ')}.`);
    if (isFamily(family)) {
        const members = items.filter((item) => item.family === family);
        members.slice(0, INSPECT_MAX_FAMILY_ENTRIES).forEach(put);
        if (members.length > INSPECT_MAX_FAMILY_ENTRIES) {
            answer.notes.push(`${family} has ${members.length} items; the first ${INSPECT_MAX_FAMILY_ENTRIES} are answered: ask for the others by name (${members.slice(INSPECT_MAX_FAMILY_ENTRIES).map((item) => item.name).join(', ')}).`);
        }
    } else if (family !== undefined && family !== null && family !== '') {
        const present = EXTENSION_FAMILIES.filter((f) => items.some((item) => item.family === f));
        answer.unknown.push(`${JSON.stringify(family)} is not a family${present.length ? ` (families: ${present.join(', ')})` : ''}`);
    }
    return answer;
}
