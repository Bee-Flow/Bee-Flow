/**
 * App Studio builder: the keys of one nav group in app_set_nav_groups, the base four written
 * here in the pinned wording, a nav-group key marked since 3 (componentSpecs/keys/navGroup/<key>.js)
 * joining after them by itself.
 *
 * A key mark describes its value as catalogue text (`shape`), which is no JSON schema, so a mark
 * that wants a place in the tool schema carries one of its own: `toolSchema`, e.g.
 * { type: 'string', enum: ['new', 'beta'] }. A mark without it stays out of the schema (the
 * argument object is never closed, so the canonicalizer still decides what a call may store;
 * navGroupSchema.test.js fails for a shipped mark in that state). Its description is the first
 * sentence of the mark's description plus where to read the whole entry.
 *
 * stripNavGroupExtensions() takes those keys out of a COPY of a tool schema again (the small band
 * and the pinned-bytes comparison read the base only). With no mark the output is byte for byte
 * the hand-written schema it replaced.
 */

import { createRequire } from 'node:module';
import { isExtensionSince } from '../catalogTiers.mts';
import { firstSentence } from './themeDesignSchema.mts';

const nodeRequire = createRequire(import.meta.url);

type SchemaNode = Record<string, unknown>;
type Mark = { since?: unknown; description?: unknown; toolSchema?: unknown };
type MarkTable = Readonly<Record<string, Mark>>;

const specs = nodeRequire('../componentSpecs.js') as { KEY_MARKS: { navGroup: MarkTable }; MAX_NAV_GROUP_LABEL: number };

const TOOL = 'app_set_nav_groups';
const isObject = (v: unknown): v is SchemaNode => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The four base keys of a nav group, in the pinned order and wording. */
function baseItemProps(): SchemaNode {
    return {
        id: { type: 'string', description: 'Existing group id (nvg_...) — keep it to preserve a group across edits.' },
        label: { type: 'string', description: `The heading shown in the nav (max ${specs.MAX_NAV_GROUP_LABEL} chars).` },
        icon: { type: 'string', description: 'Lucide icon name, e.g. "BarChart3", "Settings".' },
        screens: {
            type: 'array',
            items: { type: 'string' },
            description: 'Screen ids (scr_...) in the order they should appear under the heading.',
        },
    };
}

/** The marked nav-group keys that carry a toolSchema, as [key, schema] in file-name order. */
export function navGroupExtensionProps(marks: MarkTable = specs.KEY_MARKS.navGroup): [string, SchemaNode][] {
    const base = new Set(Object.keys(baseItemProps()));
    const out: [string, SchemaNode][] = [];
    for (const [key, mark] of Object.entries(marks)) {
        if (base.has(key) || !mark || !isExtensionSince(mark.since) || !isObject(mark.toolSchema)) continue;
        const value = JSON.parse(JSON.stringify(mark.toolSchema)) as SchemaNode;
        const gloss = firstSentence(mark.description);
        const read = `Read its entry before you use it: app_inspect_catalog {extensions:["nav.groups[].${key}"]}.`;
        out.push([key, { ...value, description: gloss ? `${gloss}. ${read}` : read }]);
    }
    return out;
}

/** The properties of one nav group: the base keys, then the marked ones. */
export function navGroupItemProps(): SchemaNode {
    return { ...baseItemProps(), ...Object.fromEntries(navGroupExtensionProps()) };
}

/** Take the marked nav-group keys out of ONE tool schema copy, in place. */
export function stripNavGroupExtensions(tool: { function?: { name?: string; parameters?: unknown } }): void {
    if (tool.function?.name !== TOOL) return;
    const params = tool.function.parameters;
    const groups = isObject(params) && isObject(params.properties) ? params.properties.groups : null;
    const items = isObject(groups) ? groups.items : null;
    const props = isObject(items) && isObject(items.properties) ? items.properties : null;
    if (!props) return;
    for (const [key] of navGroupExtensionProps()) delete props[key];
}
