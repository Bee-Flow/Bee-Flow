/**
 * App Studio runtime: how the style knob GROUPS added after the base are drawn.
 *
 * The base knobs are resolved by hand in styleResolver.ts. A knob group added later
 * (componentSpecs/styleKnobGroups/<group>.js on the server, granted by rule, see
 * expandStyleKnobs) brings one file here, styleKnobs/<group>.ts, plus its own CSS file
 * that the handler imports itself:
 *
 *   import './glow.css';
 *   const glow: StyleKnobHandler = {
 *       labels: { glow: ['studio_apps_look.knobs.glow', 'Glow'] },
 *       node: (s, style) => (s.glow === 'soft' ? 'app-glow-soft' : ''),
 *   };
 *   export default glow;
 *
 * `labels` names each knob of the group in the inspector (i18n key, English text); the
 * inspector reads them from here, so a new knob edits no shared label list.
 *
 * A handler is called only for a node or section whose style SETS one of its group's knobs,
 * so a stored app (which sets none) resolves exactly as before. It writes inline style into
 * `style` and returns extra class names ('' for none). Import helpers from
 * styleResolver.constants / styleResolver.helpers, never from styleResolver.ts itself (that
 * would close an import cycle). The directory ships empty.
 */

import { extensionKnobGroups } from './catalogSnapshot.generated.json';
import type { InlineStyle, StyleKnobs } from './styleResolver.types';

export interface StyleKnobHandler {
    /** What the inspector calls each knob of the group: knob → [i18n key, English]. */
    labels?: Readonly<Record<string, readonly [string, string]>>;
    /** A component node's style. */
    node?: (s: StyleKnobs, style: InlineStyle) => string;
    /** A section's style (only for a group granted to the section's list). */
    section?: (s: StyleKnobs, style: InlineStyle) => string;
}

interface KnobGroup {
    name: string;
    knobs: readonly string[];
}

interface RegisteredHandler {
    group: string;
    knobs: readonly string[];
    handler: StyleKnobHandler;
}

type HandlerModules = Record<string, { default: StyleKnobHandler }>;

/**
 * The handler files. Vite replaces the glob call at build time; outside Vite (the phone's
 * jest run loads this resolver to pin its port against the BASE behaviour) the call does
 * not exist and the registry is empty, which is exactly the base.
 */
function handlerModules(): HandlerModules {
    try {
        // No type argument on the call, on purpose: vitest keeps a transformed module on disk
        // between runs unless its text holds the call exactly as `import.meta.glob(`, and a
        // kept copy would not see a file added to the folder.
        return import.meta.glob(['./styleKnobs/*.ts', '!./styleKnobs/*.test.ts'], { eager: true }) as Record<string, { default: StyleKnobHandler }>;
    } catch {
        return {};
    }
}

function groupOfPath(file: string): string {
    const name = file.slice(file.lastIndexOf('/') + 1);
    return name.endsWith('.ts') ? name.slice(0, -'.ts'.length) : name;
}

/** The handlers of `modules` in file-name order, each tied to its catalog group. */
export function collectStyleKnobHandlers(modules: HandlerModules, groups: readonly KnobGroup[]): RegisteredHandler[] {
    return Object.keys(modules).sort().map((file) => {
        const name = groupOfPath(file);
        const group = groups.find((g) => g.name === name);
        if (!group) throw new Error(`styleKnobs/${name}.ts: the catalog has no extension knob group "${name}"`);
        const handler = modules[file]?.default;
        if (!handler || (typeof handler.node !== 'function' && typeof handler.section !== 'function')) {
            throw new Error(`styleKnobs/${name}.ts: the default export holds a node and/or section handler`);
        }
        return { group: name, knobs: group.knobs, handler };
    });
}

const sets = (s: StyleKnobs, knobs: readonly string[]): boolean =>
    knobs.some((k) => (s as Record<string, unknown>)[k] !== undefined && (s as Record<string, unknown>)[k] !== null);

/** Run the handlers a style sets a knob of; the extra class names, each with a leading space. */
export function applyStyleKnobHandlers(
    handlers: readonly RegisteredHandler[],
    s: StyleKnobs,
    style: InlineStyle,
    where: 'node' | 'section',
): string {
    let classes = '';
    for (const { knobs, handler } of handlers) {
        const resolve = handler[where];
        if (!resolve || !sets(s, knobs)) continue;
        const extra = resolve(s, style).trim();
        if (extra) classes += ` ${extra}`;
    }
    return classes;
}

export const STYLE_KNOB_HANDLERS: readonly RegisteredHandler[] = collectStyleKnobHandlers(
    handlerModules(),
    extensionKnobGroups as readonly KnobGroup[],
);

/** The inspector labels of the knobs of `handlers`: only for a knob of the handler's own group. */
export function collectStyleKnobLabels(handlers: readonly RegisteredHandler[]): Record<string, [string, string]> {
    const out: Record<string, [string, string]> = {};
    for (const { knobs, handler } of handlers) {
        for (const knob of knobs) {
            const label = handler.labels && Object.hasOwn(handler.labels, knob) ? handler.labels[knob] : undefined;
            if (label) out[knob] = [label[0], label[1]];
        }
    }
    return out;
}

export const STYLE_KNOB_LABELS: Readonly<Record<string, [string, string]>> = collectStyleKnobLabels(STYLE_KNOB_HANDLERS);
