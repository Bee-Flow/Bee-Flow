/**
 * App Studio: the design keys of package LK16 beside the base design (appDesignSpec.js).
 *
 *   design.tokens    named values of the app's own. A colour token (#rrggbb) can be used wherever
 *                    a colorOrRole knob takes a value, as `token:<name>` (componentSpecs/
 *                    colorValue.js); a spacing token (a whole number of pixels) is for the app's
 *                    stylesheet. Every token is also the CSS variable --app-token-<name> on the
 *                    app root, so design.customCss can read it.
 *   design.radiusPx  the corner radius of the whole app in pixels (0..32), finer than theme.radius,
 *                    which it replaces where both are set.
 *   design.dark      the colours the app uses on a dark ground: { primary?, accent?, canvas? } as
 *                    #rrggbb. Applied when the app is dark (theme.appearance "dark", or "auto" on a
 *                    dark host theme), never under the high-contrast host theme.
 *
 * Each cleaner returns the value to store or undefined when nothing in it is usable (the key is
 * then left out). The keys are optional and marked since 3 in DESIGN_SPEC, so a design without
 * them keeps its bytes. hasStyleTokenRef() is the schema-version question for the one value form
 * these keys bring to existing knobs.
 */

import { createRequire } from 'node:module';

type Obj = Record<string, unknown>;

const nodeRequire = createRequire(import.meta.url);
const { isHexColor, isTokenName, isTokenRef } = nodeRequire('./componentSpecs/colorValue.js') as {
    isHexColor: (v: unknown) => v is string;
    isTokenName: (v: unknown) => v is string;
    isTokenRef: (v: unknown) => v is string;
};

export const DESIGN_TOKEN_LIMITS = Object.freeze({
    MAX_TOKENS: 24,
    MAX_SPACING_PX: 96,
    MAX_RADIUS_PX: 32,
});

/** The keys of design.dark, in the order they are stored. */
export const DARK_PALETTE_KEYS: readonly string[] = Object.freeze(['primary', 'accent', 'canvas']);

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSpacing = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= DESIGN_TOKEN_LIMITS.MAX_SPACING_PX;

/** design.tokens as stored: valid names with a hex or a spacing value, at most MAX_TOKENS, sorted by name. */
export function cleanDesignTokens(raw: unknown): Obj | undefined {
    if (!isObject(raw)) return undefined;
    const names = Object.keys(raw).filter((name) => isTokenName(name) && (isHexColor(raw[name]) || isSpacing(raw[name]))).sort();
    const out: Obj = {};
    for (const name of names.slice(0, DESIGN_TOKEN_LIMITS.MAX_TOKENS)) out[name] = raw[name];
    return names.length ? out : undefined;
}

/** design.radiusPx as stored: a whole number 0..32, or undefined. */
export function cleanRadiusPx(raw: unknown): number | undefined {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
    return Math.min(DESIGN_TOKEN_LIMITS.MAX_RADIUS_PX, Math.max(0, Math.round(n)));
}

/** design.dark as stored: the hex colours of DARK_PALETTE_KEYS it names, or undefined. */
export function cleanDarkPalette(raw: unknown): Obj | undefined {
    if (!isObject(raw)) return undefined;
    const out: Obj = {};
    for (const key of DARK_PALETTE_KEYS) if (isHexColor(raw[key])) out[key] = raw[key];
    return Object.keys(out).length ? out : undefined;
}

/** What cleaning `raw` with `clean` took out, as a repair note, or null when it kept everything. */
function droppedNote(raw: unknown, clean: (v: unknown) => Obj | undefined, what: string, legal: string): string | null {
    if (!isObject(raw)) return null;
    const kept = clean(raw) || {};
    const dropped = Object.keys(raw).filter((k) => !Object.hasOwn(kept, k));
    return dropped.length ? `${what}: dropped ${dropped.join(', ')} (${legal}).` : null;
}

/** The repair note of design.tokens. */
export const tokensRepairNote = (raw: unknown): string | null => droppedNote(raw, cleanDesignTokens, 'design.tokens',
    `a name is a lower-case letter then lower-case letters, digits or dashes, a value #rrggbb or 0..${DESIGN_TOKEN_LIMITS.MAX_SPACING_PX}, at most ${DESIGN_TOKEN_LIMITS.MAX_TOKENS}`);

/** The repair note of design.dark. */
export const darkRepairNote = (raw: unknown): string | null => droppedNote(raw, cleanDarkPalette, 'design.dark', `keys ${DARK_PALETTE_KEYS.join(', ')} with a #rrggbb value`);

/** The colour token names of a design (the ones a `token:<name>` knob value can point at). */
export function colourTokenNames(design: unknown): Set<string> {
    const tokens = isObject(design) && isObject(design.tokens) ? design.tokens : {};
    return new Set(Object.keys(tokens).filter((name) => isHexColor(tokens[name])));
}

const MAX_WALK_DEPTH = 32;

/** Every style object of a node list (the node's own, its styleWhen rules', its columns' cellStyle rules'), with its path. */
export function* styleObjects(nodes: unknown, path: string, depth = 0): Generator<[Obj, string]> {
    if (!Array.isArray(nodes) || depth > MAX_WALK_DEPTH) return;
    for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        if (!isObject(node)) continue;
        const at = `${path}[${i}]`;
        if (isObject(node.style)) yield [node.style, `${at}.style`];
        if (Array.isArray(node.styleWhen)) {
            for (const [r, rule] of node.styleWhen.entries()) if (isObject(rule) && isObject(rule.style)) yield [rule.style, `${at}.styleWhen[${r}].style`];
        }
        const columns = isObject(node.props) && Array.isArray(node.props.columns) ? node.props.columns : [];
        for (const [c, col] of columns.entries()) {
            const rules = isObject(col) && Array.isArray(col.cellStyle) ? col.cellStyle : [];
            for (const [r, rule] of rules.entries()) if (isObject(rule) && isObject(rule.style)) yield [rule.style, `${at}.props.columns[${c}].cellStyle[${r}].style`];
        }
        yield* styleObjects(node.children, `${at}.children`, depth + 1);
    }
}

/** Every style object of a definition's screens, with its path. */
export function* definitionStyles(definition: unknown): Generator<[Obj, string]> {
    const screens = isObject(definition) && Array.isArray(definition.screens) ? definition.screens : [];
    for (const [s, screen] of screens.entries()) {
        const sections = isObject(screen) && Array.isArray(screen.sections) ? screen.sections : [];
        for (const [c, section] of sections.entries()) {
            if (isObject(section)) yield* styleObjects(section.children, `screens[${s}].sections[${c}].children`);
        }
    }
}

/** Does any style of the definition use a `token:<name>` value (which only schema 3 reads)? */
export function hasStyleTokenRef(definition: unknown): boolean {
    for (const [style] of definitionStyles(definition)) {
        if (Object.values(style).some((v) => isTokenRef(v))) return true;
    }
    return false;
}
