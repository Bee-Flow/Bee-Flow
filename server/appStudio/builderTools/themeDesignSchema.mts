/**
 * App Studio builder: the theme and design parameters of the tool schemas, built from the spec
 * tables (THEME_SPEC in core/cms/themeSpec.js, DESIGN_SPEC in appDesignSpec.js).
 *
 * Three places take them: app_set_theme (theme and design keys side by side, beside `preset` and
 * `navStyle`), and the `theme` and `design` objects of app_set_public_access. Each form lists its
 * BASE keys in the order and with the wording the pinned schemas have
 * (__tests__/toolSchemaHashes.base.json): the type and the enum come from the spec entry, the
 * wording stays here because the same key reads differently per tool and is pinned per tool.
 *
 * A key marked `since: 3` or higher (an extension key, componentSpecs/README.md) joins every form
 * that takes its table by itself, AFTER the base keys, in table order. Its description is the
 * first sentence of the spec entry's own description plus where to read the whole entry, so the
 * full text is sent once, by app_inspect_catalog, and not with every turn. Its type:
 *
 *   enum                       { type: 'string', enum: values }
 *   color, url, asset, css     { type: ['string', 'null'] } (null removes the key)
 *   anything else              the spec entry's own `toolSchema` (a JSON schema object); a key
 *                              without one is left out of the schemas (themeDesignSchema.test.js
 *                              fails for a shipped key in that state)
 *
 * stripThemeDesignExtensions() takes those keys out of a COPY of a tool schema again: the small
 * band (schemasCore.js) and the pinned-bytes comparison read the base only.
 *
 * With no extension key the output is byte for byte the hand-written schemas it replaced.
 */

import { createRequire } from 'node:module';
import { isExtensionSince } from '../catalogTiers.mts';

const nodeRequire = createRequire(import.meta.url);

type SpecEntry = { type?: string; values?: readonly unknown[]; since?: unknown; description?: unknown; toolSchema?: unknown };
type SpecTable = Readonly<Record<string, SpecEntry>>;
type SchemaNode = Record<string, unknown>;
type TableName = 'theme' | 'design';
export type ThemeDesignForm = 'setTheme' | 'publicTheme' | 'publicDesign';

const specs = nodeRequire('../componentSpecs.js') as { THEME_SPEC: SpecTable; DESIGN_SPEC: SpecTable };

const tables = (): Record<TableName, SpecTable> => ({ theme: specs.THEME_SPEC, design: specs.DESIGN_SPEC });

/** One base key of a form: its table, its key, and its pinned description (none for some). */
type BaseKey = readonly [TableName, string, string?];

const SET_THEME_BASE: readonly BaseKey[] = [
    ['theme', 'primary', 'Primary color as #rrggbb (prefer a catalog preset; never purple/violet/indigo).'],
    ['theme', 'accent', 'Call-to-action colour as #rrggbb: primary buttons and form submits paint with it, everything else stays on the primary. Unset = the primary. Pass an empty string to clear it.'],
    ['theme', 'canvas', 'Page ground colour as #rrggbb — the colour behind the sections. Unset = the platform light/dark ground. Pass an empty string to clear it.'],
    ['theme', 'radius'],
    ['theme', 'density'],
    ['theme', 'fontScale'],
    ['theme', 'appearance', 'dark/light now really re-theme the app itself, whatever theme the host is on.'],
];

/** app_set_theme's design keys come after `navStyle`, which is not a spec key. */
const SET_THEME_DESIGN_BASE: readonly BaseKey[] = [
    ['design', 'font', 'Typeface pairing. system = the host UI font (default).'],
    ['design', 'surface', 'How cards, stats and grids sit on the page. soft/elevated add depth; hairline is the default outline.'],
    ['design', 'motion', 'Animation level. Reduced-motion users always get none.'],
    ['design', 'chartPalette', 'brand derives chart colours from the primary colour.'],
    ['design', 'accentEdge', 'The coloured edge on accent cards, callouts and bar headings. bar = the default stripe; none removes it everywhere at once.'],
    ['design', 'logoUrl', 'https:// URL of a logo shown in the app chrome instead of the icon tile. Pass an empty string to remove it.'],
];

const PUBLIC_THEME_BASE: readonly BaseKey[] = [
    ['theme', 'primary', '#rrggbb — headings, links, progress, badges.'],
    ['theme', 'accent', '#rrggbb — primary buttons and form submits. Unset = the primary.'],
    ['theme', 'canvas', '#rrggbb — the page ground behind the sections.'],
    ['theme', 'radius'],
    ['theme', 'density'],
    ['theme', 'fontScale'],
    ['theme', 'appearance'],
];

const PUBLIC_DESIGN_BASE: readonly BaseKey[] = [
    ['design', 'font'],
    ['design', 'logoUrl', 'https:// URL of the customer\'s logo.'],
    ['design', 'surface'],
    ['design', 'motion'],
    ['design', 'accentEdge'],
    ['design', 'chartPalette'],
];

/** The base keys of each form, and the tables whose extension keys it takes (in that order). */
export const THEME_DESIGN_FORMS: Readonly<Record<ThemeDesignForm, { base: readonly BaseKey[]; tables: readonly TableName[] }>> = {
    setTheme: { base: [...SET_THEME_BASE, ...SET_THEME_DESIGN_BASE], tables: ['theme', 'design'] },
    publicTheme: { base: PUBLIC_THEME_BASE, tables: ['theme'] },
    publicDesign: { base: PUBLIC_DESIGN_BASE, tables: ['design'] },
};

const STRING_TYPES = new Set(['color', 'url', 'asset', 'css']);

const isObject = (v: unknown): v is SchemaNode => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The first sentence of a spec description, without its full stop (the index gloss before any cut). */
export function firstSentence(description: unknown): string {
    const flat = typeof description === 'string' ? description.split('\n').join(' ').trim() : '';
    const stop = flat.indexOf('. ');
    const first = stop >= 0 ? flat.slice(0, stop) : flat;
    return first.endsWith('.') ? first.slice(0, -1) : first;
}

/** The value part of a key's schema, from its spec entry: null when the entry cannot say. */
function valueSchema(spec: SpecEntry): SchemaNode | null {
    if (spec.type === 'enum' && Array.isArray(spec.values)) return { type: 'string', enum: [...spec.values] };
    if (typeof spec.type === 'string' && STRING_TYPES.has(spec.type)) return { type: ['string', 'null'] };
    if (isObject(spec.toolSchema)) return JSON.parse(JSON.stringify(spec.toolSchema)) as SchemaNode;
    return null;
}

/** A base key exactly as the pinned schemas write it: type, enum (for an enum), description. */
function baseProp(table: SpecTable, key: string, description: string | undefined, where: string): SchemaNode {
    const spec = table[key];
    if (!spec) throw new Error(`themeDesignSchema: ${where} names ${key}, which its spec table does not have`);
    const node: SchemaNode = { type: 'string' };
    if (spec.type === 'enum' && Array.isArray(spec.values)) node.enum = [...spec.values];
    if (description !== undefined) node.description = description;
    return node;
}

/** The extension keys of one table, as [key, schema] in table order. */
export function extensionProps(tableName: TableName, table: SpecTable = tables()[tableName]): [string, SchemaNode][] {
    const out: [string, SchemaNode][] = [];
    for (const [key, spec] of Object.entries(table)) {
        if (!spec || !isExtensionSince(spec.since)) continue;
        const value = valueSchema(spec);
        if (!value) continue;
        const gloss = firstSentence(spec.description);
        const read = `Read its entry before you use it: app_inspect_catalog {extensions:["${tableName}.${key}"]}.`;
        out.push([key, { ...value, description: gloss ? `${gloss}. ${read}` : read }]);
    }
    return out;
}

/** Keys a tool sets beside the spec keys: an extension key of the same name is never offered. */
const RESERVED_KEYS = new Set(['preset', 'navStyle']);

/** The extension properties of `form`: theme keys first, then design keys, each in table order. */
export function extensionThemeDesignProps(form: ThemeDesignForm): SchemaNode {
    const out: SchemaNode = {};
    const taken = new Set([...RESERVED_KEYS, ...THEME_DESIGN_FORMS[form].base.map(([, key]) => key)]);
    for (const tableName of THEME_DESIGN_FORMS[form].tables) {
        for (const [key, node] of extensionProps(tableName)) {
            if (taken.has(key)) continue;
            taken.add(key);
            out[key] = node;
        }
    }
    return out;
}

/**
 * Every theme and design property of one form, in the pinned order: the base theme keys, then
 * `between` (app_set_theme's navStyle), then the base design keys, then the extension keys.
 */
export function themeDesignProps(form: ThemeDesignForm, between: SchemaNode = {}): SchemaNode {
    const all = tables();
    const base = THEME_DESIGN_FORMS[form].base;
    const out: SchemaNode = {};
    const put = ([tableName, key, description]: BaseKey): void => { out[key] = baseProp(all[tableName], key, description, form); };
    base.filter(([tableName]) => tableName === 'theme').forEach(put);
    Object.assign(out, between);
    base.filter(([tableName]) => tableName === 'design').forEach(put);
    return { ...out, ...extensionThemeDesignProps(form) };
}

/** Where each form sits in a tool schema: tool name and the path of its `properties` object. */
const PLACES: readonly { tool: string; path: readonly string[]; form: ThemeDesignForm }[] = [
    { tool: 'app_set_theme', path: [], form: 'setTheme' },
    { tool: 'app_set_public_access', path: ['publicAccess', 'theme'], form: 'publicTheme' },
    { tool: 'app_set_public_access', path: ['publicAccess', 'design'], form: 'publicDesign' },
];

function propertiesAt(parameters: unknown, path: readonly string[]): SchemaNode | null {
    let node: unknown = parameters;
    for (const key of path) {
        const props: unknown = isObject(node) ? node.properties : null;
        node = isObject(props) ? props[key] : null;
    }
    return isObject(node) && isObject(node.properties) ? node.properties : null;
}

/**
 * Take the extension theme and design keys out of ONE tool schema, in place: `tool` is a copy,
 * never the shared full schema. Nothing happens while no key is marked.
 */
export function stripThemeDesignExtensions(tool: { function?: { name?: string; parameters?: unknown } }): void {
    for (const place of PLACES) {
        if (tool.function?.name !== place.tool) continue;
        const props = propertiesAt(tool.function.parameters, place.path);
        if (!props) continue;
        for (const key of Object.keys(extensionThemeDesignProps(place.form))) delete props[key];
    }
}
