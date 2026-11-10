/**
 * App Studio builder: what the catalogue's extension tier (catalogTiers.mts) means for the tool
 * schemas.
 *
 * The FULL schemas derive their enums from the whole spec lists, so they accept an extension
 * value as soon as its registry file exists: the base values first, the extension values after
 * them. With an empty registry every schema is byte for byte the base one
 * (toolSchemaHashes.test.js pins that against a list captured before this tier existed), and the
 * bytes change once per deploy that adds an entry, never per request.
 *
 *   inspectExtensionProps()  the two parameters app_inspect_catalog gains while the catalogue
 *                            has extension entries: none at all otherwise.
 *   stripExtensionTier()     the CORE projection (schemasCore.js) is the base only: the small
 *                            band gets no extension index, so its schemas offer no extension
 *                            value and no way to ask for one.
 */

import { createRequire } from 'node:module';
import { EXTENSION_FAMILIES, baseCatalogue, extensionItems, fullCatalogue } from '../catalogTiers.mts';
import type { ExtensionItem } from '../catalogTiers.mts';

const fragments = createRequire(import.meta.url)('./schemaFragments.js') as { SECTION_HEIGHT_MODES: string[]; BASE_SECTION_HEIGHT_MODES: string[] };

/** Entries one app_inspect_catalog call answers by name, and of one family. */
export const INSPECT_MAX_EXTENSIONS = 12;
export const INSPECT_MAX_FAMILY_ENTRIES = 25;

/** The plain lists a schema enum is built from, and the tables whose entries carry an enum. */
const TIERED_LISTS = ['NAV_STYLES', 'FIELD_TYPES', 'FILTER_OPS', 'AGG_FNS', 'DATE_BUCKETS'] as const;
const TIERED_ENUM_TABLES = ['STYLE_KNOBS', 'SCREEN_SPEC', 'THEME_SPEC', 'DESIGN_SPEC'] as const;

const INSPECT_TOOL = 'app_inspect_catalog';
const INSPECT_EXTENSION_KEYS = ['extensions', 'family'];

type SchemaNode = Record<string, unknown>;

const isObject = (v: unknown): v is SchemaNode => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `{ extensions, family }` for app_inspect_catalog, or `{}` when the catalogue is the base. */
export function inspectExtensionProps(): SchemaNode {
    return inspectExtensionPropsOf(extensionItems());
}

/** The same for a given item list. Pure: `{}` for none, so the schema is then the base one to the byte. */
export function inspectExtensionPropsOf(items: readonly ExtensionItem[]): SchemaNode {
    if (!items.length) return {};
    const families = EXTENSION_FAMILIES.filter((family) => items.some((item) => item.family === family));
    const examples = items.slice(0, 2).map((item) => JSON.stringify(item.name)).join(', ');
    return {
        extensions: { type: 'array', items: { type: 'string' }, description: `Extension items to expand, by the name the catalog's Extensions list gives them (max ${INSPECT_MAX_EXTENSIONS}), e.g. [${examples}].` },
        family: { type: 'string', enum: [...families], description: `Every item of one line of the Extensions list (the first ${INSPECT_MAX_FAMILY_ENTRIES}).` },
    };
}

/** Every list that differs between the tiers, as [whole, base]. */
function tieredLists(): [unknown[], unknown[]][] {
    const full = fullCatalogue();
    const base = baseCatalogue();
    if (full === base) return [];
    const pairs: [unknown[], unknown[]][] = [
        [full.STEP_KINDS, base.STEP_KINDS], [full.ACTION_KINDS, base.ACTION_KINDS],
        [fragments.SECTION_HEIGHT_MODES, fragments.BASE_SECTION_HEIGHT_MODES], // a section takes every height mode but one
    ];
    for (const list of TIERED_LISTS) {
        const [whole, basePart] = [full[list], base[list]];
        if (Array.isArray(whole) && Array.isArray(basePart)) pairs.push([whole as unknown[], basePart as unknown[]]);
    }
    // Every enum of a table whose entries can gain a value: the knobs, and the screen, theme and design keys.
    for (const table of TIERED_ENUM_TABLES) {
        const baseSpecs = (base[table] || {}) as unknown as Record<string, { values?: unknown[] } | undefined>;
        for (const [key, spec] of Object.entries((full[table] || {}) as unknown as Record<string, { values?: unknown[] }>)) {
            const baseValues = baseSpecs[key]?.values;
            if (Array.isArray(spec?.values) && Array.isArray(baseValues)) pairs.push([spec.values, baseValues]);
        }
    }
    return pairs.filter(([whole, basePart]) => whole.length !== basePart.length);
}

const sameList = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * True when `values` is the whole list, or the base list followed only by extension words of
 * that list (an enum built from a list the catalogue tier sees with more extension words, as a
 * test overlay does).
 */
export function isTieredEnum(values: unknown[], whole: unknown[], base: unknown[]): boolean {
    if (sameList(whole, values)) return true;
    if (values.length <= base.length || !sameList(values.slice(0, base.length), base)) return false;
    return values.slice(base.length).every((v) => whole.includes(v) && !base.includes(v));
}

function stripEnums(node: unknown, pairs: [unknown[], unknown[]][]): void {
    if (Array.isArray(node)) {
        for (const child of node) stripEnums(child, pairs);
        return;
    }
    if (!isObject(node)) return;
    if (Array.isArray(node.enum)) {
        const values = node.enum;
        const hit = pairs.find(([whole, base]) => isTieredEnum(values, whole, base));
        if (hit) node.enum = [...hit[1]];
    }
    for (const child of Object.values(node)) stripEnums(child, pairs);
}

/**
 * Take the extension tier out of ONE tool schema, in place. `tool` is the core projection's own
 * clone, never the shared full schema. Nothing happens while the catalogue is the base.
 */
export function stripExtensionTier(tool: { function?: { name?: string; parameters?: SchemaNode } }): void {
    const pairs = tieredLists();
    if (pairs.length) stripEnums(tool.function?.parameters, pairs);
    const props = tool.function?.parameters?.properties;
    if (tool.function?.name === INSPECT_TOOL && isObject(props)) {
        for (const key of INSPECT_EXTENSION_KEYS) delete props[key];
    }
}
